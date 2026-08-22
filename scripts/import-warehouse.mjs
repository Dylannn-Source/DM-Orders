// Loads Angel's warehouse sheet into the Offsite location.
//
// Run it from the Railway console:   node scripts/import-warehouse.mjs --yes
// Without --yes it says what it would do and changes nothing.
//
// Safe to run twice. An item already in the app keeps its counted_at, its Vori
// link and its pack size; only the fields the sheet is the authority on are
// touched, and --keep-counts leaves even the quantities alone so a re-import
// after people have started counting cannot undo their work.
import fs from 'node:fs';
import { initDb, pool } from '../src/db.js';

const args = new Set(process.argv.slice(2));
const GO = args.has('--yes');
const KEEP = args.has('--keep-counts');
const LOC = 'warehouse';
const WHO = 'Angel’s sheet';

const seed = JSON.parse(fs.readFileSync(new URL('../seed_warehouse.json', import.meta.url)));

await initDb();
const client = await pool.connect();
try {
  const { rows: before } = await client.query(
    'SELECT item_name, qty, par FROM warehouse_stock WHERE location=$1', [LOC]);
  const had = new Map(before.map(r => [r.item_name, r]));
  const incoming = new Set(seed.items.map(i => i.name));

  const isNew = seed.items.filter(i => !had.has(i.name)).length;
  const update = seed.items.length - isNew;
  // Anything already in the app that the sheet does not mention. Never deleted:
  // somebody may have added it here on purpose, and the sheet is not the only
  // way things get into the warehouse.
  const orphans = before.filter(r => !incoming.has(r.item_name)).map(r => r.item_name);

  console.log(`Angel's sheet: ${seed.items.length} items in ${seed.categories.length} categories`);
  console.log(`  ${isNew} new, ${update} already here${KEEP ? ' (quantities left alone)' : ''}`);
  if (orphans.length) {
    console.log(`  ${orphans.length} already in the app but not in the sheet, left untouched:`);
    orphans.slice(0, 10).forEach(n => console.log(`     ${n}`));
    if (orphans.length > 10) console.log(`     ...and ${orphans.length - 10} more`);
  }
  if (!GO) {
    console.log('\nNothing written. Run again with --yes to import.');
    process.exit(0);
  }

  await client.query('BEGIN');
  let pos = 0;
  for (const name of seed.categories) {
    await client.query(
      `INSERT INTO warehouse_categories (location, name, position) VALUES ($1,$2,$3)
       ON CONFLICT (location, name) DO UPDATE SET position = EXCLUDED.position`,
      [LOC, name, pos++]);
  }
  for (const it of seed.items) {
    const q = it.qty ?? 0;
    await client.query(
      `INSERT INTO warehouse_stock
         (location, item_name, brand, size, category, qty, par, onsite_par, unit, counted_at, counted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cases',NOW(),$9)
       ON CONFLICT (location, item_name) DO UPDATE SET
         brand      = EXCLUDED.brand,
         size       = EXCLUDED.size,
         category   = EXCLUDED.category,
         par        = EXCLUDED.par,
         onsite_par = EXCLUDED.onsite_par,
         qty        = CASE WHEN $10 THEN warehouse_stock.qty ELSE EXCLUDED.qty END,
         counted_at = CASE WHEN $10 THEN warehouse_stock.counted_at ELSE NOW() END,
         counted_by = CASE WHEN $10 THEN warehouse_stock.counted_by ELSE EXCLUDED.counted_by END,
         updated_at = NOW()`,
      [LOC, it.name, it.brand ?? null, it.size ?? null, it.category,
       q, it.par ?? null, it.onsite_par ?? null, WHO, KEEP]);
  }
  await client.query('COMMIT');
  const { rows: [{ n }] } = await client.query(
    'SELECT COUNT(*)::int AS n FROM warehouse_stock WHERE location=$1', [LOC]);
  console.log(`\nDone. Offsite now holds ${n} items.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Import failed, nothing changed:', e.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
