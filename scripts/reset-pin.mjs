// The way back in when every manager is locked out or has forgotten their PIN.
// Run it from the Railway console, where DATABASE_URL is already set:
//
//   node scripts/reset-pin.mjs                  list everyone
//   node scripts/reset-pin.mjs "Dylan" 4821     set a temporary PIN
//
// The PIN it sets is temporary: whoever uses it has to choose their own on the
// next sign-in. It also clears any lockout, and will promote the person to
// manager if no active manager is left, so the app can never be shut out of.
import pg from 'pg';
import { hashPin, isValidPin } from '../src/auth.js';

const [name, pin] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const ssl = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: url, ssl });

try {
  if (!name) {
    const { rows } = await pool.query(
      `SELECT name, role, active, must_change_pin, locked_until FROM employees ORDER BY name`);
    if (!rows.length) { console.log('No employees yet — open the app to create the first manager.'); }
    for (const r of rows) {
      const locked = r.locked_until && new Date(r.locked_until) > new Date() ? ' LOCKED' : '';
      console.log(`${r.name}  [${r.role}]${r.active ? '' : ' inactive'}${locked}` +
                  `${r.must_change_pin ? ' (must choose a PIN)' : ''}`);
    }
    console.log('\nTo reset one:  node scripts/reset-pin.mjs "Name" 4821');
  } else {
    if (!pin) { console.error('Give a temporary PIN too, 4 to 6 digits.'); process.exit(1); }
    const bad = isValidPin(pin, { allowShort: true });
    if (bad) { console.error(bad); process.exit(1); }
    const { rows: managers } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM employees WHERE active AND role='manager'`);
    const promote = managers[0].n === 0;
    const { rows } = await pool.query(
      `UPDATE employees
          SET pin_hash=$2, must_change_pin=TRUE, failed_attempts=0, locked_until=NULL,
              active=TRUE, role = CASE WHEN $3 THEN 'manager' ELSE role END
        WHERE name=$1 RETURNING name, role`,
      [name, hashPin(pin), promote]);
    if (!rows[0]) { console.error(`No employee called "${name}".`); process.exit(1); }
    console.log(`${rows[0].name} can sign in with ${pin} and will be asked to choose a new PIN.`);
    if (promote) console.log('No active manager remained, so they were made one.');
  }
} finally {
  await pool.end();
}
