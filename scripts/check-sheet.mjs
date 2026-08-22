// Tests the Google Sheet connection and writes nothing.
//
//   node scripts/check-sheet.mjs
//
// Run it from the Railway console after setting the variables. It says what is
// wrong in terms you can act on, or shows what the first sync would bring in.
import { initDb, pool } from '../src/db.js';
import { sheetsConfigured, syncSheet, readSheetId } from '../src/sheets.js';

const need = { GOOGLE_API_KEY: 'the read-only key from the Google console',
               WAREHOUSE_SHEET_ID: "the sheet's id, or just paste its whole URL" };
let missing = false;
for (const [k, what] of Object.entries(need)) {
  const v = (process.env[k] || '').trim();
  if (!v) { console.log(`MISSING  ${k} — ${what}`); missing = true; }
  else if (k === 'WAREHOUSE_SHEET_ID') console.log(`ok       ${k} = ${readSheetId(v)}`);
  else console.log(`ok       ${k} = ${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`);
}
console.log(`         tabs it will read: ${process.env.WAREHOUSE_SHEET_TABS || 'Inventory,Teas'}`
  + (process.env.WAREHOUSE_SHEET_TABS ? '' : '  (set WAREHOUSE_SHEET_TABS if yours are named differently)'));
if (missing) { console.log('\nSet those in Railway, redeploy, and run this again.'); process.exit(1); }

await initDb();
try {
  const r = await syncSheet({ dryRun: true });
  console.log(`\nThe sheet reads fine.`);
  console.log(`  ${r.items} items in ${r.categories} pallets`);
  console.log(`  ${r.added} would be added, ${r.changed} updated`);
  if (r.gone) console.log(`  ${r.gone} are in the app but not in the sheet — those are kept, never deleted`);
  if (r.problems.length) {
    console.log(`\n  ${r.problems.length} thing(s) to look at in the sheet:`);
    r.problems.slice(0, 10).forEach(p => console.log(`    ${p}`));
  }
  console.log('\nNothing was written. The app syncs on its own every few hours,'
    + '\nor press "Check for changes" on the Offsite tab to do it now.');
} catch (e) {
  console.log(`\nCould not read the sheet:\n  ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
