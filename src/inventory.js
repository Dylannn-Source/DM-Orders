// One count per thing we stock, in base units, built from Vori's own records.
//
// Vori keeps a case, a 5-pack and a single as three separate products with
// three separate on-hand numbers and no link between them. Selling a case
// never takes 30 packs off the single's count, so all three drift and none is
// usable. The fix is not to track three numbers better -- it is to keep one.
//
// A pool is counted in whatever a single one is. Every Vori product that draws
// on the pool carries a multiplier: a 30x case is 30 packs, a 5-pack is 5, a
// single is 1. A sale of one case takes 30 off; a delivery of 40 cases puts
// 1200 on. The count itself is never stored -- it is the sum of the ledger.
//
// Nothing here writes to Vori.
import { pool } from './db.js';
import { voriConfigured, getWithBackoff } from './vori.js';

const BASE = process.env.VORI_API_BASE || 'https://api.vori.com/v1';
const STORE = () => process.env.VORI_STORE_ID || '5084';
const TIMEOUT_MS = Number(process.env.INV_VORI_TIMEOUT_MS || 30000);

const PAGE = 100;
const MAX_PAGES = 60;

// Re-read a few days either side of the watermark every run. Receipts can be
// written up late and a run can die halfway; source_key means a line read
// twice is still only counted once, so overlapping is free and gaps are not.
const OVERLAP_DAYS = Number(process.env.INV_OVERLAP_DAYS || 3);

const qs = o => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

let last = { salesAt: null, error: null, pages: 0 };
let running = false;

// ---- what belongs to which pool ------------------------------------------

export async function linkMap() {
  const { rows } = await pool.query(
    `SELECT l.vori_product_id, l.per_unit, l.label, l.item_id, i.name, i.unit
       FROM inv_links l JOIN inv_items i ON i.id = l.item_id
      WHERE i.active`);
  const m = new Map();
  for (const r of rows) {
    m.set(String(r.vori_product_id),
      { itemId: r.item_id, perUnit: Number(r.per_unit), name: r.name,
        unit: r.unit, label: r.label });
  }
  // The biggest pack size we know for each pool. An invoice line billed by the
  // case does not say how big the case is, so this is what converts it.
  const biggest = new Map();
  for (const v of m.values()) {
    biggest.set(v.itemId, Math.max(biggest.get(v.itemId) || 1, v.perUnit));
  }
  for (const v of m.values()) v.itemCaseSize = biggest.get(v.itemId);
  return m;
}

const lineProduct = l => String(l.product?.id ?? l.productId ?? '');
const lineQty = l => {
  const q = num(l.quantity) ?? num(l.qty) ?? num(l.weight);
  return q === null ? 1 : q;
};
// A refund puts the stock back. Vori's own inventory log treats a POS refund
// as a positive adjustment, and so does this.
const isRefund = (l, t) =>
  String(l.transactionType || t.transactionType || '').toLowerCase() === 'refund'
  || !!l.refundedOrderLineItemId;

// ---- reading the registers -----------------------------------------------

async function getPage(path, params) {
  return getWithBackoff(`${BASE}/${path}?${qs(params)}`, { timeoutMs: TIMEOUT_MS });
}

const rowsOf = b =>
  b?.data || b?.transactions || b?.invoices || b?.results || (Array.isArray(b) ? b : []);

// Same shape the fried-fish board uses, and for the same reason: the documented
// endpoint pages on a cursor while has_more is true and hands back whole rows,
// line items included, so a day costs a handful of requests rather than one per
// receipt.
async function pageAll(path, baseParams, onRows) {
  let cursor = null, pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    const params = { ...baseParams, limit: String(PAGE) };
    if (cursor) params.starting_after = cursor;
    const body = await getPage(path, params);
    const rows = rowsOf(body);
    await onRows(rows);
    if (!rows.length || body?.has_more !== true) break;
    cursor = rows[rows.length - 1]?.id;
    if (!cursor) break;
  }
  return pages + 1;
}

// ---- sales out ------------------------------------------------------------

export async function syncInventorySales({ sinceIso = null } = {}) {
  if (!voriConfigured()) return { ok: false, reason: 'no_key' };
  const links = await linkMap();
  if (!links.size) return { ok: true, lines: 0, reason: 'nothing_linked' };

  const since = sinceIso || await watermark('inv_sales_through', OVERLAP_DAYS);
  let lines = 0, posted = 0;

  const pages = await pageAll('transactions', {
    'completed_at[gte]': since, type: 'sale', status: 'completed',
    store_id: STORE()
  }, async rows => {
    for (const t of rows) {
      for (const l of (t.lineItems || t.line_items || [])) {
        const link = links.get(lineProduct(l));
        if (!link) continue;
        lines++;
        const units = lineQty(l) * link.perUnit;
        if (!units) continue;
        const qty = isRefund(l, t) ? units : -units;
        const key = `sale:${l.id ?? `${t.id}:${lineProduct(l)}:${lines}`}`;
        const r = await pool.query(
          `INSERT INTO inv_ledger (item_id, qty, kind, source_key, happened_at, note)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_key) DO NOTHING`,
          [link.itemId, qty, isRefund(l, t) ? 'refund' : 'sale', key,
           t.completedAt || t.completed_at || new Date().toISOString(),
           `${link.label || 'unit'} x${lineQty(l)}`]);
        posted += r.rowCount;
      }
    }
  });

  await setWatermark('inv_sales_through', new Date().toISOString());
  last = { ...last, salesAt: new Date().toISOString(), pages, error: null };
  return { ok: true, lines, posted, pages, since };
}

// ---- deliveries in --------------------------------------------------------
//
// Vori's public API has no invoice endpoint. The whole surface is 35 paths and
// not one of them touches invoices, receiving or files -- invoices get into
// Vori as scanned documents and never come back out that way. The invoice tools
// in Vori's MCP server are not on the public API, so there is nothing to poll.
//
// What the API does serve is on-hand per product, which the app already mirrors
// into vori_inventory every half hour. Vori's own count already has the invoice
// receipts in it: when a delivery is applied, the units land on whichever
// product the vendor's line matched. They land on the WRONG member of the
// family -- a case of noodles is received against the single-pack product --
// but summing the family with its multipliers puts them back where they belong.
//
// So Vori's view of a pool is its members' on-hand, each times its multiplier.
// For Mi Goreng that is 2,850 received against the single, less 240 singles,
// 72 cases and 6 five-packs sold: 420 packs, which is the real number.
export async function voriOnHand() {
  const { rows } = await pool.query(`
    SELECT l.item_id,
           SUM(vi.on_hand * l.per_unit)                      AS units,
           COUNT(vi.product_id)                              AS members_seen,
           COUNT(l.id)                                       AS members,
           MAX(vi.synced_at)                                 AS synced_at
      FROM inv_links l
      LEFT JOIN vori_inventory vi ON vi.product_id = l.vori_product_id
     GROUP BY l.item_id`);
  const m = new Map();
  for (const r of rows) {
    m.set(r.item_id, {
      units: r.units === null ? null : Math.round(Number(r.units) * 100) / 100,
      // A pool only half covered by the mirror is not a figure to act on.
      partial: Number(r.members_seen) < Number(r.members),
      members_seen: Number(r.members_seen), members: Number(r.members),
      synced_at: r.synced_at
    });
  }
  return m;
}

// Take Vori's figure as the count. Posted as an ordinary line so it sits in the
// history next to the hand counts and can be reversed like any of them.
export async function applyVoriOnHand(itemId, who) {
  const v = (await voriOnHand()).get(Number(itemId));
  if (!v || v.units === null) throw new Error('Vori has no on-hand for this item yet');
  if (v.partial) {
    throw new Error(
      `Vori only has ${v.members_seen} of ${v.members} pack sizes for this item. `
      + 'Run the Vori product sync first.');
  }
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(qty),0) AS bal FROM inv_ledger WHERE item_id = $1', [itemId]);
  const before = Number(rows[0].bal);
  const delta = Math.round((v.units - before) * 10000) / 10000;
  await pool.query(
    `INSERT INTO inv_ledger (item_id, qty, kind, note, entered_by)
     VALUES ($1,$2,'vori',$3,$4)`,
    [itemId, delta, `Vori says ${v.units} (was ${Math.round(before * 100) / 100})`,
     who || null]);
  return { before, units: v.units, delta };
}

export async function syncInventoryAll(opts = {}) {
  if (running) return { ok: false, reason: 'already_running' };
  running = true;
  try {
    const sales = await syncInventorySales(opts);
    last = { ...last, error: null };
    return { ok: true, sales };
  } catch (e) {
    last = { ...last, error: e.message };
    throw e;
  } finally {
    running = false;
  }
}

// ---- watermarks -----------------------------------------------------------

async function watermark(key, overlapDays) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  const base = rows[0]?.value ? new Date(rows[0].value) : new Date(Date.now() - 30 * 864e5);
  return new Date(base.getTime() - overlapDays * 864e5).toISOString();
}

async function setWatermark(key, iso) {
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, iso]);
}

// ---- the board ------------------------------------------------------------

export async function invBoard() {
  const { rows } = await pool.query(`
    SELECT i.id, i.name, i.unit, i.note,
           COALESCE(SUM(l.qty), 0)                                   AS on_hand,
           COALESCE(-SUM(CASE WHEN l.kind IN ('sale','refund')
                              AND l.happened_at > NOW() - INTERVAL '30 days'
                         THEN l.qty ELSE 0 END), 0)                  AS sold_30,
           MAX(CASE WHEN l.kind = 'count' THEN l.happened_at END)    AS counted_at,
           MAX(CASE WHEN l.kind = 'receipt' THEN l.happened_at END)  AS received_at
      FROM inv_items i LEFT JOIN inv_ledger l ON l.item_id = i.id
     WHERE i.active
     GROUP BY i.id ORDER BY i.name`);

  const { rows: links } = await pool.query(
    `SELECT item_id, vori_product_id, label, per_unit FROM inv_links ORDER BY per_unit`);
  const byItem = new Map();
  for (const l of links) {
    if (!byItem.has(l.item_id)) byItem.set(l.item_id, []);
    byItem.get(l.item_id).push(
      { product: l.vori_product_id, label: l.label, per_unit: Number(l.per_unit) });
  }

  const vori = await voriOnHand();

  return rows.map(r => {
    const v = vori.get(r.id) || {};
    const onHand = Number(r.on_hand);
    const sold30 = Number(r.sold_30);
    const perDay = sold30 / 30;
    return {
      id: r.id, name: r.name, unit: r.unit, note: r.note,
      on_hand: Math.round(onHand * 100) / 100,
      sold_30: Math.round(sold30 * 100) / 100,
      // Already short means no days left, not negative days left.
      days_left: perDay > 0 ? Math.max(0, Math.round(onHand / perDay)) : null,
      counted_at: r.counted_at, received_at: r.received_at,
      // What Vori's own numbers add up to for this pool, and how far our
      // ledger has drifted from it. Shown rather than applied: the two
      // disagreeing is information, not an error to paper over.
      vori_on_hand: v.units ?? null,
      vori_partial: !!v.partial,
      vori_gap: v.units === null || v.units === undefined
        ? null : Math.round((onHand - v.units) * 100) / 100,
      members: byItem.get(r.id) || []
    };
  });
}

export async function itemHistory(itemId, limit = 60) {
  const { rows } = await pool.query(
    `SELECT id, qty, kind, note, happened_at, entered_by
       FROM inv_ledger WHERE item_id = $1
      ORDER BY happened_at DESC, id DESC LIMIT $2`, [itemId, limit]);
  return rows.map(r => ({ ...r, qty: Number(r.qty) }));
}

// ---- entering things by hand ---------------------------------------------

// A physical count is the truth, and the gap between it and the ledger is the
// shrink, the miscount and the sale that never got rung. Rather than overwrite
// anything, this posts the difference, so the count stays a sum of its history
// and what the gap was on the day stays on the record.
export async function recordCount(itemId, counted, who) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(qty),0) AS bal FROM inv_ledger WHERE item_id = $1', [itemId]);
  const before = Number(rows[0].bal);
  const delta = Math.round((Number(counted) - before) * 10000) / 10000;
  await pool.query(
    `INSERT INTO inv_ledger (item_id, qty, kind, note, entered_by)
     VALUES ($1,$2,'count',$3,$4)`,
    [itemId, delta, `counted ${counted} (was ${Math.round(before * 100) / 100})`, who || null]);
  return { before, counted: Number(counted), delta };
}

export async function recordReceipt(itemId, units, note, who) {
  const u = Number(units);
  if (!Number.isFinite(u) || u === 0) throw new Error('units must be a number');
  await pool.query(
    `INSERT INTO inv_ledger (item_id, qty, kind, note, entered_by)
     VALUES ($1,$2,'receipt',$3,$4)`, [itemId, u, note || 'entered by hand', who || null]);
  return { units: u };
}

export async function reverseLine(id, who) {
  const { rows } = await pool.query(
    'SELECT item_id, qty, kind FROM inv_ledger WHERE id = $1', [id]);
  if (!rows[0]) throw new Error('no such line');
  await pool.query(
    `INSERT INTO inv_ledger (item_id, qty, kind, note, entered_by)
     VALUES ($1,$2,'adjust',$3,$4)`,
    [rows[0].item_id, -Number(rows[0].qty), `reverses #${id}`, who || null]);
  return { reversed: id };
}

// ---- items and links ------------------------------------------------------

export async function addItem(name, unit) {
  const { rows } = await pool.query(
    `INSERT INTO inv_items (name, unit) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET active = TRUE RETURNING id, name, unit`,
    [String(name).trim(), (unit || 'pack').trim()]);
  return rows[0];
}

export async function addLink(itemId, voriProductId, perUnit, label) {
  const { rows } = await pool.query(
    `INSERT INTO inv_links (item_id, vori_product_id, label, per_unit)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (vori_product_id)
       DO UPDATE SET item_id = EXCLUDED.item_id, per_unit = EXCLUDED.per_unit,
                     label = EXCLUDED.label
     RETURNING id`,
    [itemId, String(voriProductId), label || null, Number(perUnit)]);
  return rows[0];
}

export async function removeLink(id) {
  await pool.query('DELETE FROM inv_links WHERE id = $1', [id]);
  return { ok: true };
}

// ---- the spreadsheet ------------------------------------------------------

// Dates arrive from pg as Date objects; String() on one gives "Wed Oct 14 2026"
// rather than a date a spreadsheet will sort.
const day = v => v ? new Date(v).toISOString().slice(0, 10) : '';

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function invCsv() {
  const board = await invBoard();
  const head = ['Item', 'Unit', 'On hand', 'Vori says', 'Difference',
                'Sold last 30 days', 'Days left',
                'Last counted', 'Last delivery', 'Pack sizes'];
  const lines = [head.join(',')];
  for (const r of board) {
    lines.push([
      r.name, r.unit, r.on_hand, r.vori_on_hand ?? '', r.vori_gap ?? '',
      r.sold_30, r.days_left ?? '',
      day(r.counted_at), day(r.received_at),
      r.members.map(m => `${m.label || m.product}=${m.per_unit}`).join(' ')
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

export async function invDiag() {
  const { rows: counts } = await pool.query(`
    SELECT (SELECT COUNT(*) FROM inv_items WHERE active) AS items,
           (SELECT COUNT(*) FROM inv_links)              AS links,
           (SELECT COUNT(*) FROM inv_ledger)             AS ledger_lines`);
  return {
    has_key: voriConfigured(),
    store: STORE(),
    base: BASE,
    items: Number(counts[0].items),
    links: Number(counts[0].links),
    ledger_lines: Number(counts[0].ledger_lines),
    // Vori's public API serves no invoices; deliveries reach a pool through
    // Vori's own on-hand mirror, or by hand.
    invoices_on_api: false,
    last_sales_sync: last.salesAt,
    last_error: last.error,
    running
  };
}
