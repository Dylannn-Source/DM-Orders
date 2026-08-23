// Turns a walking order described in sections into the order the app lists items in.
//
//   node scripts/set-walk.mjs            # says what it would do
//   node scripts/set-walk.mjs --yes      # saves it
//
// Nobody should have to put 174 items in order. produce_sections.json groups them
// into eighteen sections once; walk_produce.json says what order those sections
// are walked in, separately for the shelves and for the back room, because they
// are not arranged the same way. Everything else falls out of those two lists.
import fs from 'node:fs';
import { initDb, pool } from '../src/db.js';

const GO = process.argv.includes('--yes');
const DEPT = 'produce';
const sections = JSON.parse(fs.readFileSync(new URL('../produce_sections.json', import.meta.url)));
const walk = JSON.parse(fs.readFileSync(new URL('../walk_produce.json', import.meta.url)));

await initDb();
const { rows } = await pool.query('SELECT name FROM items WHERE dept=$1 AND active', [DEPT]);
const real = new Set(rows.map(r => r.name));

let bad = false;
for (const [pass, order] of Object.entries(walk)) {
  if (pass.startsWith('_')) continue;                       // a note to a human, not a pass
  if (!['shelf', 'back'].includes(pass)) { console.log(`Unknown pass "${pass}".`); bad = true; continue; }
  const names = [];
  const unknown = order.filter(s => !sections[s]);
  unknown.forEach(s => console.log(`  ${pass}: no section called "${s}"`));
  // A section left out of the order is the easy mistake, and it would quietly
  // dump those items at the bottom of the list rather than where they are walked.
  const left = Object.keys(sections).filter(s => !order.includes(s));
  left.forEach(s => console.log(`  ${pass}: section "${s}" is not in the order — ${sections[s].length} items would land at the end`));
  if (unknown.length) bad = true;

  order.forEach(s => (sections[s] || []).forEach(n => { if (real.has(n) && !names.includes(n)) names.push(n); }));
  const missing = [...real].filter(n => !names.includes(n));
  console.log(`${pass}: ${names.length} items in ${order.length} sections`
    + (missing.length ? `, ${missing.length} not placed` : ''));
  missing.slice(0, 8).forEach(n => console.log(`    not placed: ${n}`));

  if (GO && !bad) {
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [`walk_${DEPT}_${pass}`, JSON.stringify(names)]);
  }
}
console.log(GO && !bad ? '\nSaved. Open Produce and the list will be in that order.'
                       : '\nNothing written. Run again with --yes once it looks right.');
await pool.end();
