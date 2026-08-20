// Load a backup file from Settings -> Backup back into a database.
//
//   node scripts/restore.mjs dat-moi-backup-2026-08-20.json --yes
//
// Reads DATABASE_URL from the environment, the same as the app. This REPLACES
// everything in the database with the contents of the file, so it asks for
// --yes before touching anything. The whole load runs in one transaction: if
// any part of it fails, the database is left exactly as it was.
import fs from 'fs';
import pg from 'pg';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup.json> --yes');
  process.exit(1);
}
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const summary = backup.counts_summary || {};
console.log(`Backup taken ${backup.exported_at}`);
console.log(`  ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(', ')}`);

if (!flags.includes('--yes')) {
  console.error('\nThis replaces everything currently in the database.');
  console.error('Re-run with --yes to go ahead.');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const ssl = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: url, ssl });

const cols = {
  items: ['dept','name','invdesc','vendor','vendor2','case_size','unit','note','mode','shelf_target','pars','active','sort_order'],
  counts: ['dept','item_name','shelf','cooler','qty'],
  routes: ['dept','name','position','item_names'],
  vendors: ['dept','name'],
  order_history: ['dept','vendor','day_label','order_date','items'],
  session_state: ['dept','day_key']
};
const JSON_COLS = new Set(['pars','item_names','items']);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const table of ['counts','routes','vendors','order_history','session_state','items']) {
    await client.query(`DELETE FROM ${table}`);
  }
  for (const [table, names] of Object.entries(cols)) {
    const rows = backup[table === 'order_history' ? 'order_history' : table] || [];
    for (const row of rows) {
      const vals = names.map(c => JSON_COLS.has(c) && row[c] !== null && typeof row[c] === 'object'
        ? JSON.stringify(row[c]) : row[c]);
      await client.query(
        `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`,
        vals);
    }
    console.log(`  ${table}: ${rows.length}`);
  }
  await client.query('COMMIT');
  console.log('Restored.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Restore failed, database left unchanged:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
