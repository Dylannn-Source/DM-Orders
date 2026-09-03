// Fills in the Vietnamese names on the offsite warehouse from warehouse_vi.json.
//
// The app does this on its own the first time it boots with stock loaded, so
// this is only needed to look at what would be written, or to fill in names for
// items added after that first run.
//
//   node scripts/apply-vi-names.mjs            # show what it would do
//   node scripts/apply-vi-names.mjs --yes      # do it
import { initDb, pool } from '../src/db.js';
import { fillViNames, viFor, viForCategory } from '../src/vi.js';

const GO = process.argv.includes('--yes');
const LOC = 'warehouse';

await initDb();

const { rows } = await pool.query(
  `SELECT item_name, brand, size, name_vi FROM warehouse_stock WHERE location=$1 ORDER BY item_name`, [LOC]);
const { rows: cats } = await pool.query(
  `SELECT name, name_vi FROM warehouse_categories WHERE location=$1 ORDER BY position, name`, [LOC]);

const blank = rows.filter(r => !r.name_vi);
const plan = blank.map(r => [r.item_name, viFor(r)]).filter(([, v]) => v);
const noMatch = blank.filter(r => !viFor(r)).map(r => r.item_name);
const catPlan = cats.filter(c => !c.name_vi && viForCategory(c.name));

console.log(`${rows.length} items, ${cats.length} pallets.`);
console.log(`  ${rows.length - blank.length} items already have a Vietnamese name, left alone`);
console.log(`  ${plan.length} would get one`);
console.log(`  ${noMatch.length} have no translation in the table`);
console.log(`  ${catPlan.length} pallets would get one`);
if (noMatch.length) console.log('\nNo translation for:\n  ' + noMatch.join('\n  '));
if (plan.length){
  console.log('\nA sample of what would be written:');
  plan.slice(0, 12).forEach(([n, v]) => console.log(`  ${n}\n      ${v}`));
}

if (!GO) {
  console.log('\nNothing written. Run again with --yes to apply.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const n = await fillViNames(client);
  await client.query('COMMIT');
  console.log(`\nWritten: ${n.items} items, ${n.pallets} pallets.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Nothing written:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
