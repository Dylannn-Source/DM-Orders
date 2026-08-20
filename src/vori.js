// Read-only mirror of Vori's on-hand quantities.
//
// Vori counts every unit the business owns, wherever it sits. The warehouse tab
// counts one location. Subtracting one from the other says what should be at the
// store, which is the number nobody currently has.
//
// Nothing here writes to Vori. The API key should be a read-only one.
import { pool } from './db.js';

const BASE = process.env.VORI_API_BASE || 'https://api.vori.com/v1';
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
// Each window starts slightly before the last one ended, so a quantity written
// while a sync was in flight is picked up rather than stepped over.
const WATERMARK_BUFFER_MS = 5 * 60 * 1000;

export const voriConfigured = () => !!process.env.VORI_API_KEY;

function headers() {
  return { Authorization: `Bearer ${process.env.VORI_API_KEY}`, Accept: 'application/json' };
}

async function getWithBackoff(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: headers() });
    if (res.status !== 429) {
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Vori ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
    // Wait exactly as long as the response asks rather than guessing.
    const wait = Number(res.headers.get('Retry-After') || 5) * 1000;
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error('Vori still rate limiting after ' + MAX_RETRIES + ' attempts');
}

// The published guide names the on-hand field only in passing and the object
// page is empty, so rather than hard-coding a guess this tries the plausible
// names and reports which one it found. The first real sync settles it.
const QTY_FIELDS = ['current', 'quantity', 'on_hand', 'onHand', 'qty', 'available'];
export function readQuantity(record) {
  for (const f of QTY_FIELDS) {
    const v = record?.[f];
    if (v !== undefined && v !== null && isFinite(Number(v))) return { qty: Number(v), field: f };
  }
  return { qty: null, field: null };
}

async function config(key) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key=$1', [key]);
  return rows[0]?.value || null;
}
async function setConfig(key, value) {
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}

export async function syncInventory({ full = false } = {}) {
  if (!voriConfigured()) throw new Error('VORI_API_KEY is not set');
  const watermark = full ? null : await config('vori_watermark');
  // Taken before fetching, not after: a quantity written mid-run can land behind
  // it and would be missed on the next pass.
  const nextWatermark = new Date(Date.now() - WATERMARK_BUFFER_MS).toISOString();

  let cursor = null, seen = 0, field = null, pages = 0;
  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (watermark) params.set('updated_at[gte]', watermark);
    if (cursor) params.set('starting_after', cursor);
    if (process.env.VORI_STORE_ID) params.set('store_id', process.env.VORI_STORE_ID);

    const body = await getWithBackoff(`${BASE}/store-product-inventory?${params}`);
    const page = body.data || [];
    pages++;

    for (const rec of page) {
      const { qty, field: f } = readQuantity(rec);
      if (f && !field) field = f;
      if (qty === null) continue;
      await pool.query(
        `INSERT INTO vori_inventory (product_id, on_hand, vori_updated_at, synced_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (product_id)
         DO UPDATE SET on_hand=EXCLUDED.on_hand, vori_updated_at=EXCLUDED.vori_updated_at,
                       synced_at=NOW()`,
        [String(rec.id), qty, rec.updated_at || null]);
      seen++;
    }
    if (!body.has_more || !page.length) break;
    cursor = page[page.length - 1].id;
  }

  // Only after everything in the window is written — pages arrive in id order,
  // so a run that stops halfway holds part of the catalogue, not the early part
  // of the window. Moving the watermark there would skip the rest for good.
  await setConfig('vori_watermark', nextWatermark);
  await setConfig('vori_last_sync', new Date().toISOString());
  if (field) await setConfig('vori_qty_field', field);
  return { records: seen, pages, quantityField: field, full: !watermark };
}

export async function voriStatus() {
  const [last, qtyField, count] = await Promise.all([
    config('vori_last_sync'), config('vori_qty_field'),
    pool.query('SELECT COUNT(*)::int AS n FROM vori_inventory')
  ]);
  return {
    configured: voriConfigured(),
    last_sync: last,
    quantity_field: qtyField,
    products: count.rows[0].n
  };
}

// Catalogue search, so a warehouse line can be pointed at the right product.
export async function searchProducts(q) {
  if (!voriConfigured()) throw new Error('VORI_API_KEY is not set');
  const params = new URLSearchParams({ limit: '25', include: 'inventory' });
  if (process.env.VORI_STORE_ID) params.set('store_id', process.env.VORI_STORE_ID);
  const body = await getWithBackoff(`${BASE}/store-products?${params}`);
  const needle = String(q || '').toLowerCase();
  return (body.data || [])
    .filter(p => !needle || String(p.name || '').toLowerCase().includes(needle))
    .map(p => ({ id: String(p.id), name: p.name, barcode: p.barcode || null }));
}
