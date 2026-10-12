// Watching Vori for the payment on a fried fish.
//
// The clerk weighs the fish and hands over a slip; the customer pays at a
// register; the fryer has to know the money is in. Everything goes through one
// variable-price PLU -- 1001, Fried Fish -- with the slip price keyed in, so
// what we are looking for is a fried-fish line at this ticket's price.
//
// The species PLUs are accepted too, in case one is ever rung that way, but
// nothing depends on the clerk and the cashier having picked the same one. The
// species on the ticket is for the fryer to read, not for matching.
//
// Nothing here writes to Vori, and nothing here is load-bearing: when Vori is
// not connected, or the call fails, or the match is not certain, the ticket
// simply stays where it is and somebody taps it. This only ever saves a walk.
import { pool } from './db.js';
import { voriConfigured, getWithBackoff } from './vori.js';

const BASE = process.env.VORI_API_BASE || 'https://api.vori.com/v1';
const STORE = () => process.env.VORI_STORE_ID || '5084';

// A fish rung up a minute before the clerk finished typing the ticket is still
// that fish. The window opens slightly before the ticket to allow for it.
const GRACE_MS = 3 * 60 * 1000;
// Rounding between a scale and a register is worth a penny or two, no more.
const CENTS = 0.02;
// Somebody is standing at the oil waiting on this, so it gives up quickly and
// says so rather than leaving a button saying "Checking..." for ever.
const TIMEOUT_MS = Number(process.env.FRY_VORI_TIMEOUT_MS || 10000);

// The published API docs name the inventory resource and little else, so rather
// than hard-coding a guess the first call tries the plausible names and the one
// that answers is remembered. Same approach the inventory sync already takes to
// Vori's unnamed quantity field.
const PATHS = ['transactions', 'store-transactions', 'checkout-transactions', 'orders'];
let listPath = process.env.VORI_TRANSACTIONS_PATH || null;

// What to ask for, and under what names.
//
// The resource is right -- it answers -- but it is particular about its query,
// and it says so in useful terms: a 400 reading "property storeId should not
// exist" names the thing it would not take. So a guess is made, the refusal is
// read, the offending names are dropped, and it is asked again. A request with
// nothing on it is the floor, and that is survivable: the time window is
// checked against every ticket here anyway, so filtering at the server is a
// saving rather than something correctness rests on.
const PARAM_SETS = iso => [
  { storeId: STORE(), completedAtFrom: iso, take: '50' },
  { store_id: STORE(), completed_at_from: iso, limit: '50' },
  { storeId: STORE() },
  {}
];
// Whatever it turned out to accept, so the learning happens once.
let paramPlan = null;

// "property storeId should not exist" -> storeId
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

let lastError = null, lastRun = null, lastMatched = 0, lastLooked = 0;
// How many came back and how many fell inside the window. With no query
// parameters accepted there is no server-side filter, so if the page it
// returns is not the recent end of the list this is where that shows: plenty
// listed, none in the window, nothing ever matching and no error to explain it.
let lastListed = 0, lastInWindow = 0;
// How many line items in the window looked like a fried fish, and what the
// last transaction's lines were shaped like. The list call working proves the
// connection; it does not prove the reply is laid out the way the lines are
// read here. If fish wait while transactions arrive, this is the next
// question, and guessing at it again is not worth anybody's evening.
let lastFriedLines = 0, lastLineKeys = null, lastLineSample = null;
// When a call to Vori last actually succeeded. Without this the board would say
// "watching the registers" on the strength of a key being present, having never
// once reached Vori -- and the first anybody would know is a fryer standing at
// the oil waiting for a confirmation that was never coming.
let lastOk = null;

// Transactions already fetched, so a poll every few seconds does not ask for
// the same receipt over and over. Only as long as a fish waits to be paid for.
const seen = new Map();
function pruneSeen(before) {
  for (const [id, v] of seen) if (v.at < before) seen.delete(id);
}

const money = v => (v === null || v === undefined || v === '') ? null : Number(v);

async function listSince(iso) {
  const paths = listPath ? [listPath] : PATHS;
  let last;
  for (const p of paths) {
    for (const start of (paramPlan ? [paramPlan(iso)] : PARAM_SETS(iso))) {
      const params = { ...start };
      // A few rounds at most, dropping whatever it objected to each time.
      for (let round = 0; round < 4; round++) {
        try {
          const url = `${BASE}/${p}${Object.keys(params).length ? '?' + qs(params) : ''}`;
          const body = await getWithBackoff(url, { timeoutMs: TIMEOUT_MS });
          listPath = p;
          const keys = Object.keys(params);
          // Remember the shape that worked, so the learning happens once.
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
          // Vori wraps its lists differently in different places; take whichever
          // array came back rather than insisting on one shape.
          return body?.transactions || body?.results || body?.data
            || (Array.isArray(body) ? body : []);
        } catch (e) {
          last = e;
          if (e.status === 404) break;          // wrong resource, try the next name
          const dropped = rejectedProps(e).filter(k => k in params);
          if (e.status === 400 && dropped.length) {
            dropped.forEach(k => delete params[k]);
            continue;                            // ask again without them
          }
          // Understood and refused. Nothing to learn by rephrasing it.
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
  const tries = listPath ? [listPath] : PATHS;
  for (const p of tries) {
    try { return await getWithBackoff(`${BASE}/${p}/${encodeURIComponent(id)}`,
        { timeoutMs: TIMEOUT_MS }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  return null;
}

// What the shelf price was, before tax. The slip the customer carries is the
// pre-tax price, and the catch-all fried fish PLU is taxed, so comparing
// against the line's total would miss every one of those by ten per cent.
const lineAmount = l => money(l.retailTotal) ?? money(l.subtotal) ?? money(l.total);
const lineProduct = l => String(l.product?.id ?? l.productId ?? '');
const linePlu = l => String(l.product?.barcode ?? l.plu ?? '');

// Which products count as a fried fish going out of the door. PLU 1001 is the
// one actually used; the weighed species are in here so a line rung that way is
// not missed. Read once and kept, since it changes about never.
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
const isFriedLine = (l, set) =>
  set.ids.has(lineProduct(l)) || set.plus.has(linePlu(l));

let watchStarted = null, attempts = 0;

export function fryVoriStatus() {
  return {
    configured: voriConfigured(),
    // Reached Vori at least once. "A key is set" is not the same thing.
    verified: !!lastOk,
    last_ok: lastOk,
    path: listPath,
    last_run: lastRun,
    last_error: lastError,
    matched: lastMatched,
    looked: lastLooked,
    // Enough to tell "the press never arrived" from "the press arrived and
    // went nowhere", which are different problems and look identical.
    attempts,
    listed: lastListed,
    in_window: lastInWindow,
    fried_lines_seen: lastFriedLines,
    watch_started: watchStarted,
    busy: !!inFlight
  };
}

// Everything about how this is wired, for when the board says one thing and the
// registers say another. No key in it: whether one is set, never what it is.
export function fryDiag() {
  return {
    ...fryVoriStatus(),
    base: BASE,
    store: STORE(),
    has_key: !!(process.env.VORI_API_KEY || '').trim(),
    key_length: (process.env.VORI_API_KEY || '').trim().length,
    forced_path: process.env.VORI_TRANSACTIONS_PATH || null,
    // The query it settled on, so a wrong page or a missing filter is visible.
    params: paramPlan ? Object.keys(paramPlan(new Date().toISOString())) : null,
    timeout_ms: TIMEOUT_MS,
    watch_seconds: Number(process.env.FRY_WATCH_SECONDS || 10),
    line_keys: lastLineKeys,
    line_sample: lastLineSample,
    build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7)
        || process.env.SOURCE_COMMIT?.slice(0, 7) || null,
    started_at: BOOT
  };
}
const BOOT = new Date().toISOString();

// One pass. Returns what it did, and never throws at its caller.
// One pass at a time. A slow or hanging call every few seconds would otherwise
// stack up connections behind it and bury the reason anybody can see.
let inFlight = null;
export async function matchFryPayments(opts = {}) {
  if (!voriConfigured()) return { skipped: 'vori not connected' };
  if (inFlight) return inFlight;
  inFlight = runMatch(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runMatch({ probe = false } = {}) {
  attempts++;
  lastRun = new Date().toISOString();
  try {
    // A price is the whole of what identifies a ticket now, so one without a
    // price cannot be matched and is left for a person. The board says so.
    const { rows: open } = await pool.query(
      `SELECT id, number, price, created_at
         FROM fry_tickets
        WHERE day = CURRENT_DATE AND status = 'waiting' AND price IS NOT NULL`);
    lastLooked = open.length;
    if (!open.length) {
      lastRun = new Date().toISOString();
      // Nothing to match, so normally nothing to ask. But a connection nobody
      // has ever tested is worth one call: on the quiet morning somebody sets
      // the key, that is the difference between finding out now and finding
      // out at the oil.
      if (probe || !lastOk) {
        await listSince(new Date(Date.now() - 60 * 1000).toISOString());
      }
      lastError = null;
      return { open: 0, probed: probe || true };
    }

    // Always from the oldest fish still waiting, rather than from a saved
    // cursor. A ticket written after the cursor moved on would otherwise never
    // have its payment looked for, and the window is only ever minutes wide.
    const oldest = open.reduce((a, t) => Math.min(a, new Date(t.created_at).getTime()), Infinity);
    const since = new Date(oldest - GRACE_MS);
    pruneSeen(since.getTime() - GRACE_MS);

    const fried = await friedProducts();
    const txns = await listSince(since.toISOString());
    let matched = 0;
    // Oldest first, so the first fish in the queue gets the first payment.
    const ordered = [...txns].sort((a, b) =>
      new Date(a.completedAt || 0) - new Date(b.completedAt || 0));

    // The server may not have narrowed the list -- its filter is a saving, not
    // something leaned on -- so anything older than the window is dropped here
    // before a single detail is fetched for it.
    const floor = since.getTime();
    const inWindow = ordered.filter(x => !x.completedAt
      || new Date(x.completedAt).getTime() >= floor).slice(-60);
    lastListed = ordered.length;
    lastInWindow = inWindow.length;
    for (const t of inWindow) {
      if (!t?.id) continue;
      if (String(t.transactionStatus || t.status || '').toLowerCase().includes('void')) continue;
      let lines = seen.get(t.id)?.lines;
      if (!lines) {
        const full = await detail(t.id);
        lines = full?.lineItems || full?.line_items || [];
        seen.set(t.id, { at: new Date(t.completedAt || Date.now()).getTime(), lines });
      }
      const when = new Date(t.completedAt || Date.now()).getTime();

      if (lines.length && !lastLineKeys) {
        lastLineKeys = Object.keys(lines[0] || {});
        // Shape only: what a line is called and what it costs, never who bought it.
        lastLineSample = {
          product_id: lineProduct(lines[0]) || null,
          plu: linePlu(lines[0]) || null,
          amount: lineAmount(lines[0])
        };
      }
      for (const l of lines) {
        if (!isFriedLine(l, fried)) continue;
        lastFriedLines++;
        const amt = lineAmount(l);
        if (amt === null) continue;
        const lineId = String(l.id || `${t.id}:${lineProduct(l)}:${amt}`);

        // Still waiting, this price, rung up after the fish was written down.
        const fits = open.filter(k =>
          k.matched !== true &&
          when >= new Date(k.created_at).getTime() - GRACE_MS &&
          Math.abs(Number(k.price) - amt) <= CENTS);

        // Exactly one, or nobody is told anything. Price is all there is to go
        // on, so two fish at the same price in the same few minutes is a coin
        // toss -- and a coin toss is worse than the walk it replaces. Those
        // wait for a person.
        if (fits.length !== 1) continue;
        const k = fits[0];

        const { rows } = await pool.query(
          `UPDATE fry_tickets
              SET status='paid', paid_at=NOW(), paid_by='Vori', paid_source='vori',
                  vori_txn=$2, vori_line_id=$3, updated_at=NOW()
            WHERE id=$1 AND status='waiting' RETURNING number`,
          [k.id, String(t.shopperFacingId || t.id), lineId]).catch(e => {
            // The unique index refusing means this line already settled another
            // ticket. Leave both alone.
            if (e.code === '23505') return { rows: [] };
            throw e;
          });
        if (rows[0]) { k.matched = true; matched++; }
      }
    }
    lastRun = new Date().toISOString();
    lastError = null;
    lastMatched = matched;
    return { open: open.length, transactions: ordered.length, matched, path: listPath };
  } catch (e) {
    lastError = e.message;
    lastRun = new Date().toISOString();
    console.warn('fry payment watch:', e.message);
    return { error: e.message };
  }
}

// Only while the store is likely to be frying anything. A poll that finds no
// open tickets costs one query against our own database and no call to Vori.
export function startFryWatch() {
  if (!voriConfigured()) {
    console.log('Fried fish: Vori not connected, payments are confirmed by hand.');
    return null;
  }
  const every = Number(process.env.FRY_WATCH_SECONDS || 10) * 1000;
  console.log(`Fried fish: watching Vori for payments every ${every / 1000}s.`);
  watchStarted = new Date().toISOString();
  // Straight away, not in ten seconds: whether this works at all is worth
  // knowing at boot, and it is written into the log where it can be read.
  matchFryPayments({ probe: true })
    .then(r => console.log('Fried fish: first look at Vori -', JSON.stringify(r)))
    .catch(e => console.warn('Fried fish: first look at Vori failed -', e.message));
  const timer = setInterval(() => { matchFryPayments().catch(() => {}); }, every);
  timer.unref?.();
  return timer;
}
