// Fills in the Vietnamese names on the offsite warehouse from warehouse_vi.json.
//
// Only ever fills a blank. A name somebody typed at the pallet is theirs and
// this does not touch it, so the script is safe to run again after the sheet
// has added items.
//
//   node scripts/apply-vi-names.mjs            # show what it would do
//   node scripts/apply-vi-names.mjs --yes      # do it
import { readFileSync } from 'node:fs';
import { initDb, pool } from '../src/db.js';

const GO = process.argv.includes('--yes');
const LOC = 'warehouse';
const root = new URL('..', import.meta.url);
const vi = JSON.parse(readFileSync(new URL('warehouse_vi.json', root), 'utf8'));
const seed = JSON.parse(readFileSync(new URL('seed_warehouse.json', root), 'utf8'));

// The seed knows each item's description outright. Anything that arrived from
// the sheet instead has to have it worked back out of the composed name, which
// is brand + description + size with single spaces between.
const descOf = {};
for (const it of seed.items) if (it.desc) descOf[it.name] = it.desc;
function deriveDesc(row) {
  let s = row.item_name;
  if (row.brand && s.startsWith(row.brand + ' ')) s = s.slice(row.brand.length + 1);
  if (row.size && s.endsWith(' ' + row.size)) s = s.slice(0, -(row.size.length + 1));
  return s.trim();
}
// Spelling in the sheet is not consistent -- "Pineapple Gel In Syrup" and
// "Pineapple Gel in Syrup" are the same product -- so the lookup ignores case
// and runs of spaces.
const table = {};
for (const [k, v] of Object.entries(vi.by_desc)) table[k.toLowerCase().replace(/\s+/g, ' ')] = v;
const lookup = d => table[String(d || '').toLowerCase().replace(/\s+/g, ' ')] || null;

await initDb();

const { rows } = await pool.query(
  `SELECT item_name, brand, size, name_vi FROM warehouse_stock WHERE location=$1 ORDER BY item_name`, [LOC]);
const { rows: cats } = await pool.query(
  `SELECT name, name_vi FROM warehouse_categories WHERE location=$1 ORDER BY position, name`, [LOC]);

const plan = [], kept = [], noMatch = [];
for (const r of rows) {
  if (r.name_vi) { kept.push(r.item_name); continue; }
  const v = lookup(descOf[r.item_name]) || lookup(deriveDesc(r));
  if (v) plan.push([r.item_name, v]); else noMatch.push(r.item_name);
}
const catPlan = cats.filter(c => !c.name_vi && vi.categories[c.name])
                    .map(c => [c.name, vi.categories[c.name]]);

console.log(`${rows.length} items, ${cats.length} pallets.`);
console.log(`  ${plan.length} items would get a Vietnamese name`);
console.log(`  ${kept.length} already have one, left alone`);
console.log(`  ${noMatch.length} have no translation in the table`);
console.log(`  ${catPlan.length} pallets would get one`);
if (noMatch.length) console.log('\nNo translation for:\n  ' + noMatch.join('\n  '));
console.log('\nA sample of what would be written:');
plan.slice(0, 12).forEach(([n, v]) => console.log(`  ${n}\n      ${v}`));

if (!GO) {
  console.log('\nNothing written. Run again with --yes to apply.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [name, v] of plan) {
    await client.query(
      `UPDATE warehouse_stock SET name_vi=$3 WHERE location=$1 AND item_name=$2 AND name_vi IS NULL`,
      [LOC, name, v]);
  }
  for (const [name, v] of catPlan) {
    await client.query(
      `UPDATE warehouse_categories SET name_vi=$3 WHERE location=$1 AND name=$2 AND name_vi IS NULL`,
      [LOC, name, v]);
  }
  await client.query('COMMIT');
  console.log(`\nWritten: ${plan.length} items, ${catPlan.length} pallets.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Nothing written:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
