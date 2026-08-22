// Reads Angel's warehouse sheet out of Google Sheets, read-only.
//
// The split is deliberate and it is the whole design: the sheet owns the
// catalogue -- which products exist, what they are called, which pallet they sit
// on, what the par is -- and the app owns the counts. Angel keeps adding
// products where adding products is easy for him, and nobody's counting gets
// overwritten at three in the morning by a figure somebody typed last week.
//
// Auth is an API key against a link-shared sheet, not OAuth and not a service
// account. A key cannot write, cannot reach anything not shared with the link,
// and needs no consent screen or key rotation ceremony. Restrict it to the
// Sheets API in the Google console and it can do nothing else.
import { pool } from './db.js';

// Overridable so the client can be driven against a stand-in during testing.
const API = (process.env.GOOGLE_SHEETS_BASE || 'https://sheets.googleapis.com')
  .replace(/\/+$/, '') + '/v4/spreadsheets';
const LOC = 'warehouse';
// Shown as who counted a freshly imported item, so its number is never mistaken
// for somebody having walked the pallet.
const SOURCE = 'Angel\u2019s sheet';

const KEY = () => (process.env.GOOGLE_API_KEY || '').trim();
const SHEET_ID = () => (process.env.WAREHOUSE_SHEET_ID || '').trim();
// Which tabs to read, in order. Angel keeps Teas apart from Inventory.
const TABS = () => (process.env.WAREHOUSE_SHEET_TABS || 'Inventory,Teas')
  .split(',').map(s => s.trim()).filter(Boolean);

export const sheetsConfigured = () => !!(KEY() && SHEET_ID());

async function config(key) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key=$1', [key]);
  return rows[0]?.value || null;
}
async function setConfig(key, value) {
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}

// A spreadsheet id, not a URL. People paste the whole address, so pull the id
// back out of it rather than failing with something unhelpful.
export function readSheetId(v) {
  const s = String(v || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

async function fetchTab(tab) {
  // UNFORMATTED_VALUE gives numbers as numbers; the display value of a par is
  // sometimes " 20 " with a stray space, and " 20 " is not 20.
  const url = `${API}/${encodeURIComponent(readSheetId(SHEET_ID()))}/values/`
    + `${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&key=${encodeURIComponent(KEY())}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    // Google's own wording is accurate but not actionable, so say what to do.
    if (res.status === 403 && /consumer|unregistered/i.test(msg)) {
      throw new Error('GOOGLE_API_KEY is missing or not allowed to use the Sheets API.');
    }
    if (res.status === 403) {
      throw new Error('The sheet is not shared. Open it, Share, "Anyone with the link" → Viewer.');
    }
    if (res.status === 400 && /API key not valid/i.test(msg)) {
      throw new Error('GOOGLE_API_KEY is not a valid key.');
    }
    if (res.status === 404) {
      throw new Error(`No sheet with that id, or no tab called "${tab}".`);
    }
    throw new Error(msg);
  }
  return body.values || [];
}

const text = v => (v === null || v === undefined ? '' : String(v).trim());
function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
}

// Angel's layout: a row with only column A is a category heading, and every row
// under it belongs to that heading until the next one. Row 1 is the header.
// Columns: Brand | Description | Size | Need @ Store | Storage Unit | PAR |
//          Order | Next Door W.H. | Stocked W.H.
export function parseRows(rows) {
  const items = [];
  const categories = [];
  const problems = [];
  let cat = null;
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;                                  // 1-based, past the header
    const c = Array.from({ length: 9 }, (_, k) => text(r[k]));
    if (c.every(x => !x)) return;
    if (c[0] && c.slice(1).every(x => !x)) {
      cat = c[0];
      if (!categories.includes(cat)) categories.push(cat);
      return;
    }
    if (!c[1]) { problems.push(`Row ${line} has no description, skipped.`); return; }
    const name = [c[0], c[1], c[2]].filter(Boolean).join(' ');
    items.push({
      name, brand: c[0] || null, size: c[2] || null, category: cat,
      // Only ever used the first time an item appears. See the insert below.
      qty: num(r[4]) ?? 0,
      par: num(r[5]), onsite_par: num(r[7]), line
    });
  });
  // Two rows composing to one name would silently become one item.
  const seen = new Map();
  for (const it of items) {
    const k = it.name.toLowerCase();
    if (seen.has(k)) problems.push(`Rows ${seen.get(k)} and ${it.line} are both "${it.name}".`);
    else seen.set(k, it.line);
  }
  return { items, categories, problems };
}

export async function syncSheet({ dryRun = false } = {}) {
  if (!sheetsConfigured()) throw new Error('GOOGLE_API_KEY and WAREHOUSE_SHEET_ID are not both set');

  const all = [];
  const cats = [];
  const problems = [];
  for (const tab of TABS()) {
    const parsed = parseRows(await fetchTab(tab));
    parsed.items.forEach(i => all.push(i));
    parsed.categories.forEach(c => { if (!cats.includes(c)) cats.push(c); });
    parsed.problems.forEach(p => problems.push(`${tab}: ${p}`));
  }
  // An empty read is far more likely to be a broken sheet than a real emptying,
  // and acting on it would wipe the catalogue. Refuse and say so.
  if (!all.length) throw new Error('The sheet came back with no items. Nothing changed.');

  const { rows: existing } = await pool.query(
    `SELECT item_name, brand, size, category, par, onsite_par
       FROM warehouse_stock WHERE location=$1`, [LOC]);
  const have = new Map(existing.map(r => [r.item_name, r]));
  const incoming = new Set(all.map(i => i.name));

  const added = all.filter(i => !have.has(i.name)).map(i => i.name);
  const changed = all.filter(i => {
    const was = have.get(i.name);
    if (!was) return false;
    const same = (a, b) => (a ?? null) === (b ?? null);
    // Postgres hands NUMERIC back as a string, and two absent pars are equal --
    // comparing them through NaN made every par-less row report as changed, so a
    // quiet sync claimed two hundred changes and a real one would have hidden in
    // the noise.
    const sameNum = (a, b) => {
      const an = a === null || a === undefined, bn = b === null || b === undefined;
      return an || bn ? an && bn : Number(a) === Number(b);
    };
    return !same(was.brand, i.brand) || !same(was.size, i.size)
        || !same(was.category, i.category)
        || !sameNum(was.par, i.par)
        || !sameNum(was.onsite_par, i.onsite_par);
  }).map(i => i.name);
  // Never deleted. Somebody may have added it in the app on purpose, and a row
  // vanishing from a spreadsheet is as often a mis-drag as a decision.
  const gone = existing.filter(r => !incoming.has(r.item_name)).map(r => r.item_name);

  const summary = {
    items: all.length, categories: cats.length,
    added: added.length, changed: changed.length, gone: gone.length,
    added_names: added.slice(0, 20), gone_names: gone.slice(0, 20),
    problems, dry_run: dryRun
  };
  if (dryRun) return summary;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let pos = 0;
    for (const name of cats) {
      await client.query(
        `INSERT INTO warehouse_categories (location, name, position) VALUES ($1,$2,$3)
         ON CONFLICT (location, name) DO UPDATE SET position = EXCLUDED.position`,
        [LOC, name, pos++]);
    }
    for (const it of all) {
      // The count is taken from the sheet only when the item is new, because at
      // that moment the app holds no count of its own to lose and the sheet's
      // figure is the only one anybody has. From then on the quantity, who
      // counted it and when are the app's, and this statement does not mention
      // them -- so a sync landing mid-count cannot undo anyone's work. Without
      // that first-time seed a fresh connection reads 215 items at zero and
      // calls two thirds of them under par, which is false and useless.
      await client.query(
        `INSERT INTO warehouse_stock
           (location, item_name, brand, size, category, par, onsite_par, qty, unit, counted_at, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cases',NOW(),$9)
         ON CONFLICT (location, item_name) DO UPDATE SET
           brand      = EXCLUDED.brand,
           size       = EXCLUDED.size,
           category   = EXCLUDED.category,
           par        = EXCLUDED.par,
           onsite_par = EXCLUDED.onsite_par,
           updated_at = NOW()`,
        [LOC, it.name, it.brand, it.size, it.category, it.par, it.onsite_par,
         it.qty, SOURCE]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  await setConfig('sheet_last_sync', new Date().toISOString());
  await setConfig('sheet_last_result', JSON.stringify({
    items: summary.items, added: summary.added, changed: summary.changed,
    gone: summary.gone, problems: problems.length
  }));
  return summary;
}

export async function sheetStatus() {
  const [last, result, err] = await Promise.all([
    config('sheet_last_sync'), config('sheet_last_result'), config('sheet_last_error')
  ]);
  let parsed = null;
  try { parsed = result ? JSON.parse(result) : null; } catch { /* a bad cache is not an error */ }
  return {
    configured: sheetsConfigured(),
    sheet_id: sheetsConfigured() ? readSheetId(SHEET_ID()) : null,
    tabs: TABS(),
    last_sync: last,
    last: parsed,
    last_error: err
  };
}

export async function noteSheetError(message) {
  await setConfig('sheet_last_error', message ? `${new Date().toISOString()} ${message}` : '');
}
