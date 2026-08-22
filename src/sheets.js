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
    // These are all 403s and they need completely different fixes, so the
    // catch-all must not be the sharing one -- an unenabled API told you to go
    // and change a sharing setting that was already correct.
    const reason = body?.error?.details?.find(d => d.reason)?.reason || '';
    if (res.status === 403 && (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(msg))) {
      throw new Error('The Google Sheets API is not switched on for this Google Cloud project. '
        + 'Enable it at https://console.cloud.google.com/apis/library/sheets.googleapis.com '
        + 'and try again. Until it is on, it will not appear in the key\u2019s API-restriction list either.');
    }
    if (res.status === 403 && /consumer|unregistered/i.test(msg)) {
      throw new Error('GOOGLE_API_KEY is missing or not allowed to use the Sheets API.');
    }
    if (res.status === 403 && /API_KEY_SERVICE_BLOCKED|blocked/i.test(msg + reason)) {
      throw new Error('This key is restricted and the Sheets API is not on its allowed list. '
        + 'Edit the key, API restrictions, tick Google Sheets API.');
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

// Columns are found by their heading, not by where they sit.
//
// Angel is going to keep working in this sheet -- pallet numbers are coming, and
// who knows what else. Reading column F as the par only holds until somebody
// inserts a column, and then every row imports its par from the Order column and
// its count from somewhere else, silently, across all 215 rows. A heading can be
// moved, and things that get moved should not break.
//
// Spelling is forgiven, order is not required, and an unknown column is ignored
// rather than fatal -- he can add whatever he likes.
const FIELDS = {
  brand:  ['brand'],
  desc:   ['description', 'item', 'product', 'name', 'desc'],
  size:   ['size', 'sz'],
  need:   ['needstore', 'needatstore', 'need'],
  qty:    ['storageunit', 'storage', 'warehouse', 'wh', 'onhand', 'count', 'qty', 'quantity'],
  par:    ['par', 'parlevel', 'target'],
  onsite: ['nextdoorwh', 'nextdoor', 'nextdoorwarehouse', 'onsite', 'onsitewh'],
  pallet: ['pallet', 'palletnumber', 'palletno', 'pallets', 'location', 'spot', 'bay', 'row'],
  // Some rows he counts by the case and some by the pack. If he ever says which
  // in a column, believe it; until then everything is cases, as it is today.
  unit:   ['unit', 'units', 'countedby', 'countedas', 'casepack', 'by']
};

const slug = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function readHeader(row) {
  const at = {};
  (row || []).forEach((cell, i) => {
    const k = slug(cell);
    if (!k) return;
    for (const [field, names] of Object.entries(FIELDS)) {
      if (at[field] !== undefined) continue;
      if (names.includes(k)) { at[field] = i; return; }
    }
  });
  return at;
}

const text = v => (v === null || v === undefined ? '' : String(v).trim());
function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : null;
}
// "packs", "loose", "each" mean the number beside it is not a count of cases.
const LOOSE = /^(pack|packs|loose|each|ea|unit|units|single|singles|pc|pcs|bottle|bottles)$/;

// A row with a single piece of text and no numbers is a heading -- the pallet or
// product group everything under it belongs to, until the next one.
export function parseRows(rows) {
  const head = readHeader(rows[0]);
  const items = [], categories = [], problems = [];
  if (head.desc === undefined || head.qty === undefined) {
    const saw = (rows[0] || []).map(text).filter(Boolean).join(', ') || '(the first row is empty)';
    throw new Error('Could not find the columns in this sheet. It needs a heading row with '
      + 'a description column and a count column. The first row reads: ' + saw);
  }
  const cell = (r, f) => head[f] === undefined ? '' : text(r[head[f]]);
  const cellNum = (r, f) => head[f] === undefined ? null : num(r[head[f]]);

  let cat = null, palletOf = {};
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const filled = (r || []).map(text).filter(Boolean);
    if (!filled.length) return;
    // A heading is a row naming a group and nothing else: no description, no
    // count. It is not "exactly one cell" -- the whole point of a pallet column
    // is that he writes the pallet on the heading row, and demanding a lone cell
    // made every group he labelled stop being a group.
    if (!cell(r, 'desc') && cellNum(r, 'qty') === null) {
      const pal = cell(r, 'pallet');
      const name = (r || []).map(text).find((v, i) => v && i !== head.pallet);
      if (!name) return;
      cat = name;
      if (!categories.includes(cat)) categories.push(cat);
      if (pal) palletOf[cat] = pal;
      return;
    }
    const desc = cell(r, 'desc');
    if (!desc) { problems.push(`Row ${line} has no description, skipped.`); return; }
    const brand = cell(r, 'brand') || null;
    const size = cell(r, 'size') || null;
    // A pallet written on any row is taken as the group's pallet: he is far more
    // likely to write it once against the heading than on all thirty-eight rows.
    const pal = cell(r, 'pallet');
    if (pal && cat && !palletOf[cat]) palletOf[cat] = pal;
    const loose = LOOSE.test(slug(cell(r, 'unit')));
    items.push({
      name: [brand, desc, size].filter(Boolean).join(' '),
      brand, size, category: cat,
      qty: cellNum(r, 'qty') ?? 0,
      loose,                                  // the count is packs, not cases
      unit: cell(r, 'unit') || null,
      par: cellNum(r, 'par'), onsite_par: cellNum(r, 'onsite'), line
    });
  });
  const seen = new Map();
  for (const it of items) {
    const k = it.name.toLowerCase();
    if (seen.has(k)) problems.push(`Rows ${seen.get(k)} and ${it.line} are both "${it.name}".`);
    else seen.set(k, it.line);
  }
  return { items, categories, problems, pallets: palletOf, columns: Object.keys(head) };
}

export async function syncSheet({ dryRun = false } = {}) {
  if (!sheetsConfigured()) throw new Error('GOOGLE_API_KEY and WAREHOUSE_SHEET_ID are not both set');

  const all = [];
  const cats = [];
  const problems = [];
  const pallets = {};
  for (const tab of TABS()) {
    const parsed = parseRows(await fetchTab(tab));
    parsed.items.forEach(i => all.push(i));
    parsed.categories.forEach(c => { if (!cats.includes(c)) cats.push(c); });
    parsed.problems.forEach(p => problems.push(`${tab}: ${p}`));
    Object.assign(pallets, parsed.pallets);
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
    pallets_named: Object.keys(pallets).length,
    loose_counted: all.filter(i => i.loose).length,
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
      // A pallet number typed here by hand is never wiped by a sheet that does
      // not carry one; the sheet only wins where it actually says something.
      await client.query(
        `INSERT INTO warehouse_categories (location, name, position, pallets) VALUES ($1,$2,$3,$4)
         ON CONFLICT (location, name) DO UPDATE SET
           position = EXCLUDED.position,
           pallets  = COALESCE(EXCLUDED.pallets, warehouse_categories.pallets)`,
        [LOC, name, pos++, pallets[name] || null]);
    }
    for (const it of all) {
      // The count is taken from the sheet only when the item is new, because at
      // that moment the app holds no count of its own to lose and the sheet's
      // figure is the only one anybody has. From then on the quantity, who
      // counted it and when are the app's, and this statement does not mention
      // them -- so a sync landing mid-count cannot undo anyone's work. Without
      // that first-time seed a fresh connection reads 215 items at zero and
      // calls two thirds of them under par, which is false and useless.
      // Some rows he counts by the case and some by the pack. Where the sheet
      // says which, the number lands in the matching column -- putting forty
      // packs into the cases column would read as forty cases on the pallet.
      // Where it says nothing, everything is cases, as it is today.
      await client.query(
        `INSERT INTO warehouse_stock
           (location, item_name, brand, size, category, par, onsite_par,
            qty, qty_units, pick_loose, unit, counted_at, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 CASE WHEN $10::boolean THEN 0 ELSE $8::numeric END,
                 CASE WHEN $10::boolean THEN $8::numeric ELSE 0 END,
                 $10::boolean, COALESCE($11::text,'cases'), NOW(), $9)
         ON CONFLICT (location, item_name) DO UPDATE SET
           brand      = EXCLUDED.brand,
           size       = EXCLUDED.size,
           category   = EXCLUDED.category,
           par        = EXCLUDED.par,
           onsite_par = EXCLUDED.onsite_par,
           -- once true it stays true: somebody taking loose here proved it
           pick_loose = warehouse_stock.pick_loose OR EXCLUDED.pick_loose,
           updated_at = NOW()`,
        [LOC, it.name, it.brand, it.size, it.category, it.par, it.onsite_par,
         it.qty, SOURCE, !!it.loose, it.unit]);
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
