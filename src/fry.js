// The fried fish that have been paid for, read off the registers.
//
// The paper slip the customer carries is the ticket; this app does not try to
// be one. The clerk weighs the fish and prices it, the customer pays, and the
// only question the fryer has is whether this slip's price has been through a
// till yet. So the board is a list of paid fried fish, newest first, and a slip
// that is not on it has not been paid for.
//
// Nothing here writes to Vori.
import { pool } from './db.js';
import { voriConfigured, getWithBackoff } from './vori.js';

const BASE = process.env.VORI_API_BASE || 'https://api.vori.com/v1';
const STORE = () => process.env.VORI_STORE_ID || '5084';
// Somebody is standing at the fryer waiting on this.
const TIMEOUT_MS = Number(process.env.FRY_VORI_TIMEOUT_MS || 10000);

const PATHS = ['transactions', 'store-transactions', 'checkout-transactions', 'orders'];
let listPath = process.env.VORI_TRANSACTIONS_PATH || null;

// What to ask for, and under what names.
//
// The resource answers but is particular about its query, and says so in useful
// terms: a 400 reading "property storeId should not exist" names what it would
// not take. So a guess goes out, the refusal is read, the offending names are
// dropped, and it is asked again. A bare request is the floor, and that is
// survivable -- what matters is the recent end of the list, and everything is
// filtered to today here anyway.
const PARAM_SETS = iso => [
  { storeId: STORE(), completedAtFrom: iso, take: '100' },
  { store_id: STORE(), completed_at_from: iso, limit: '100' },
  { limit: '100' },
  { storeId: STORE() },
  {}
];
let paramPlan = null;

function rejectedProps(e) {
  const msg = e?.body?.message;
  const lines = Array.isArray(msg) ? msg : (typeof msg === 'string' ? [msg] : []);
  const out = [];
  for (const l of lines) {
    const m = String(l).match(/property\s+(\w+)\s+should not exist/i);
    if (m) out.push(m[1]);
  }
  return out;
}
const qs = o => Object.entries(o)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

let lastError = null, lastRun = null, lastOk = null, watchStarted = null;
let attempts = 0, lastListed = 0, lastNew = 0, lastFound = 0;
let lastLineKeys = null, lastLineSample = null;
const BOOT = new Date().toISOString();

// Transaction ids already looked inside. A receipt's contents never change, so
// once its lines have been read there is no reason to ask again.
const readAlready = new Set();

async function listRecent(iso) {
  const paths = listPath ? [listPath] : PATHS;
  let last;
  for (const p of paths) {
    for (const start of (paramPlan ? [paramPlan(iso)] : PARAM_SETS(iso))) {
      const params = { ...start };
      for (let round = 0; round < 4; round++) {
        try {
          const url = `${BASE}/${p}${Object.keys(params).length ? '?' + qs(params) : ''}`;
          const body = await getWithBackoff(url, { timeoutMs: TIMEOUT_MS });
          listPath = p;
          const keys = Object.keys(params);
          paramPlan = when => {
            const o = {};
            for (const k of keys) {
              o[k] = /store/i.test(k) ? STORE()
                   : /(from|since|after|start)/i.test(k) ? when
                   : start[k];
            }
            return o;
          };
          lastOk = new Date().toISOString();
          return body?.transactions || body?.results || body?.data
            || (Array.isArray(body) ? body : []);
        } catch (e) {
          last = e;
          if (e.status === 404) break;
          const dropped = rejectedProps(e).filter(k => k in params);
          if (e.status === 400 && dropped.length) {
            dropped.forEach(k => delete params[k]);
            continue;
          }
          if (e.status === 401 || e.status === 403) throw e;
          break;
        }
      }
    }
  }
  throw new Error(
    `Could not list transactions at ${BASE}. Tried paths: ${paths.join(', ')}.`
    + (last ? ` Last reply: ${last.message}` : ''));
}

async function detail(id) {
  const paths = listPath ? [listPath] : PATHS;
  for (const p of paths) {
    try {
      return await getWithBackoff(`${BASE}/${p}/${encodeURIComponent(id)}`,
        { timeoutMs: TIMEOUT_MS });
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return null;
}

const money = v => (v === null || v === undefined || v === '') ? null : Number(v);
// The number written on the slip is the shelf price, before tax. The line's own
// total has the county's ten and a half per cent on top of it, which is the
// figure on the customer's receipt -- both are worth showing, neither is the
// other.
const preTax = l => money(l.retailTotal) ?? money(l.subtotal) ?? money(l.total);
const withTax = l => money(l.total) ?? preTax(l);
const lineProduct = l => String(l.product?.id ?? l.productId ?? '');
const linePlu = l => String(l.product?.barcode ?? l.plu ?? '');

// Which products count as a fried fish. In practice everything goes through the
// one variable-price PLU; the weighed species are here so a line rung that way
// is not missed either.
let friedIds = null;
async function friedProducts() {
  if (friedIds) return friedIds;
  const { rows } = await pool.query(
    'SELECT plu, vori_product_id FROM fry_products WHERE active');
  friedIds = {
    ids: new Set(rows.map(r => String(r.vori_product_id)).filter(Boolean)),
    plus: new Set(rows.map(r => String(r.plu)).filter(Boolean))
  };
  return friedIds;
}
const isFried = (l, set) => set.ids.has(lineProduct(l)) || set.plus.has(linePlu(l));

// One pass: read whatever is new off the registers and write down the fried
// fish among it.
let inFlight = null;
export async function syncFryPayments(opts = {}) {
  if (!voriConfigured()) return { skipped: 'vori not connected' };
  if (inFlight) return inFlight;
  inFlight = runSync(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runSync({ hours = 14 } = {}) {
  attempts++;
  lastRun = new Date().toISOString();
  try {
    const fried = await friedProducts();
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const txns = await listRecent(since.toISOString());
    lastListed = txns.length;

    // Oldest first, so a day fills in the order it happened.
    const ordered = [...txns]
      .filter(t => t?.id && !String(t.transactionStatus || '').toLowerCase().includes('void'))
      .filter(t => !t.completedAt || new Date(t.completedAt) >= since)
      .sort((a, b) => new Date(a.completedAt || 0) - new Date(b.completedAt || 0));

    let found = 0, added = 0;
    for (const t of ordered) {
      if (readAlready.has(t.id)) continue;
      const full = await detail(t.id);
      const lines = full?.lineItems || full?.line_items || [];
      readAlready.add(t.id);
      if (lines.length && !lastLineKeys) {
        lastLineKeys = Object.keys(lines[0] || {});
        lastLineSample = { product_id: lineProduct(lines[0]) || null,
                           plu: linePlu(lines[0]) || null, amount: preTax(lines[0]) };
      }
      for (const l of lines) {
        if (!isFried(l, fried)) continue;
        const amount = preTax(l);
        if (amount === null) continue;
        found++;
        // Lane and cashier come off the list, which names them; the detail call
        // gives ids only.
        const { rowCount } = await pool.query(
          `INSERT INTO fry_payments
             (line_id, txn_id, receipt, amount, amount_tax, paid_at, lane, cashier, plu, product_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (line_id) DO NOTHING`,
          [String(l.id || `${t.id}:${lineProduct(l)}:${amount}`), String(t.id),
           String(t.shopperFacingId || t.id), amount, withTax(l),
           t.completedAt || new Date().toISOString(),
           t.laneName || t.lane?.name || null,
           t.cashierName || t.employeeName || null,
           linePlu(l) || null, lineProduct(l) || null]);
        added += rowCount;
      }
    }
    // Only ever as many receipts as a long day holds.
    if (readAlready.size > 4000) readAlready.clear();
    lastFound = found; lastNew = added;
    lastError = null;
    return { listed: txns.length, looked: ordered.length, fried: found, added };
  } catch (e) {
    lastError = e.message;
    console.warn('fry payments:', e.message);
    return { error: e.message };
  }
}

// Today's board, out of our own table so a slow till cannot empty the screen.
export async function fryBoard() {
  const { rows } = await pool.query(
    `SELECT line_id, receipt, amount, amount_tax, paid_at, lane, cashier
       FROM fry_payments
      WHERE paid_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
      ORDER BY paid_at DESC`, [process.env.STORE_TZ || 'America/Los_Angeles']);
  return rows.map(r => ({
    id: r.line_id, receipt: r.receipt,
    amount: Number(r.amount),
    amount_tax: r.amount_tax === null ? null : Number(r.amount_tax),
    paid_at: r.paid_at, lane: r.lane, cashier: r.cashier
  }));
}

export function fryVoriStatus() {
  return {
    configured: voriConfigured(),
    verified: !!lastOk,
    last_ok: lastOk,
    path: listPath,
    last_run: lastRun,
    last_error: lastError,
    attempts,
    listed: lastListed,
    fried_lines_seen: lastFound,
    added_last_run: lastNew,
    watch_started: watchStarted,
    busy: !!inFlight
  };
}

export function fryDiag() {
  return {
    ...fryVoriStatus(),
    base: BASE,
    store: STORE(),
    has_key: !!(process.env.VORI_API_KEY || '').trim(),
    key_length: (process.env.VORI_API_KEY || '').trim().length,
    forced_path: process.env.VORI_TRANSACTIONS_PATH || null,
    params: paramPlan ? Object.keys(paramPlan(new Date().toISOString())) : null,
    timeout_ms: TIMEOUT_MS,
    watch_seconds: Number(process.env.FRY_WATCH_SECONDS || 10),
    receipts_read: readAlready.size,
    line_keys: lastLineKeys,
    line_sample: lastLineSample,
    build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7)
        || process.env.SOURCE_COMMIT?.slice(0, 7) || null,
    started_at: BOOT
  };
}

export function startFryWatch() {
  if (!voriConfigured()) {
    console.log('Fried fish: Vori not connected, the board will stay empty.');
    return null;
  }
  const every = Number(process.env.FRY_WATCH_SECONDS || 10) * 1000;
  console.log(`Fried fish: reading the registers every ${every / 1000}s.`);
  watchStarted = new Date().toISOString();
  // Straight away, and over a long window, so a deploy in the middle of a
  // trading day comes up with the day already on the board rather than empty.
  syncFryPayments({ hours: 14 })
    .then(r => console.log('Fried fish: first read -', JSON.stringify(r)))
    .catch(e => console.warn('Fried fish: first read failed -', e.message));
  const timer = setInterval(() => { syncFryPayments().catch(() => {}); }, every);
  timer.unref?.();
  return timer;
}
