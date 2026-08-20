import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Railway's Postgres exposes both DATABASE_URL and DATABASE_PRIVATE_URL, and the
// reference picker offers either, so accept whichever name the variable landed on.
const URL_VARS = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL'];
const URL_VAR = URL_VARS.find(v => (process.env[v] || '').trim());
// Strip stray wrapping quotes — pasting a quoted value into the dashboard is easy
// to do and otherwise fails far away from the cause.
const RAW_URL = URL_VAR ? process.env[URL_VAR].trim().replace(/^["']|["']$/g, '') : undefined;

// Never print credentials, even while diagnosing.
function redact(v) {
  return String(v).replace(/(:\/\/[^:/@]*:)[^@]*@/, '$1***@');
}

// A malformed connection string otherwise surfaces as "getaddrinfo ENOTFOUND base",
// which names neither the variable nor the problem. Check it up front instead.
function urlProblem(v) {
  if (v.includes('${{') || v.includes('}}')) {
    return [
      `${URL_VAR} still holds an unresolved Railway reference:`,
      `    ${v}`,
      '',
      'Railway leaves that text verbatim when the name inside the braces does not',
      'match a service in this project. Open the database service and read its exact',
      'name from the header, then use:',
      '    ${{<that exact name>.DATABASE_URL}}',
      '',
      'Simpler: delete the variable, then use Variables -> Add a Reference and pick',
      'the database from the list. Railway fills in the right name itself.'
    ];
  }
  if (!/^postgres(ql)?:\/\//i.test(v)) {
    return [
      `${URL_VAR} is not a Postgres connection string. It is set to:`,
      `    ${redact(v)}`,
      '',
      'It should look like:  postgresql://user:password@host:5432/railway'
    ];
  }
  try {
    const u = new URL(v);
    if (!u.hostname) throw new Error('no host');
  } catch {
    return [`${URL_VAR} is not a valid URL:`, `    ${redact(v)}`];
  }
  return null;
}

if (RAW_URL) {
  const problem = urlProblem(RAW_URL);
  if (problem) {
    console.error(['', ...problem, ''].join('\n'));
    process.exit(1);
  }
}

const DATABASE_URL = RAW_URL;

if (!DATABASE_URL) {
  console.error([
    '',
    'No database connection string found, so there is nothing to connect to.',
    `Checked: ${URL_VARS.join(', ')}.`,
    '',
    'On Railway this means no Postgres is linked to this service. Railway does',
    'not share one service\'s variables with another automatically:',
    '',
    '  1. In the project canvas, check a Postgres database exists.',
    '     If not: New -> Database -> Add PostgreSQL',
    '  2. Open THIS service (not the database) -> Variables -> New Variable',
    '  3. Name: DATABASE_URL   Value: ${{Postgres.DATABASE_URL}}',
    '     (match "Postgres" to whatever the database service is actually named)',
    '  4. Deploy.',
    '',
    'Locally, pass it on the command line:',
    '  DATABASE_URL="postgres://user:pass@localhost:5432/datmoi" npm start',
    ''
  ].join('\n'));
  process.exit(1);
}

// Railway's private network (*.railway.internal) speaks plain TCP; its public
// proxy and most hosted providers require TLS. Guess from the hostname, and if
// the server disagrees, initDb retries the other way rather than crash-looping.
// Set DATABASE_SSL=on/off to skip the guessing entirely.
function prefersSsl(url) {
  const override = process.env.DATABASE_SSL;
  if (override) return !/^(0|false|off|disable|disabled|no)$/i.test(override);
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through to no TLS */ }
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host.endsWith('.railway.internal')) return false;
  return true;
}

function isSslMismatch(err) {
  const m = String(err && err.message || '');
  return /does not support SSL/i.test(m)           // we offered TLS, server has none
      || /SSL( connection)? is required/i.test(m)  // server demands TLS, we sent none
      || /\bno encryption\b/i.test(m)              // pg_hba refused the plaintext attempt
      || /\bSSL off\b/i.test(m);                   // same, older server wording
}

async function openPool(ssl) {
  const p = new Pool({ connectionString: DATABASE_URL, ssl });
  try {
    await p.query('SELECT 1');   // prove the connection before we hand it out
    return p;
  } catch (err) {
    await p.end().catch(() => {});
    throw err;
  }
}

// Reassigned by initDb once a working connection is established. Importers read
// it through an ES module live binding, and every use is behind initDb().
export let pool;

export async function initDb() {
  const wantSsl = prefersSsl(DATABASE_URL);
  const first = wantSsl ? { rejectUnauthorized: false } : false;
  try {
    pool = await openPool(first);
  } catch (err) {
    if (!isSslMismatch(err)) throw err;
    console.warn(`Postgres refused the ${wantSsl ? 'TLS' : 'plaintext'} connection ` +
                 `(${err.message}). Retrying ${wantSsl ? 'without' : 'with'} TLS.`);
    pool = await openPool(wantSsl ? false : { rejectUnauthorized: false });
  }
  console.log(`Connected to Postgres at ${new URL(DATABASE_URL).host}` +
              `${pool.options.ssl ? ' over TLS' : ''} (via ${URL_VAR}).`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id            SERIAL PRIMARY KEY,
      dept          TEXT NOT NULL,
      name          TEXT NOT NULL,
      invdesc       TEXT DEFAULT '',
      vendor        TEXT,
      case_size     NUMERIC,
      unit          TEXT,
      note          TEXT,
      mode          TEXT NOT NULL DEFAULT 'single',
      shelf_target  NUMERIC,
      pars          JSONB NOT NULL DEFAULT '{}'::jsonb,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (dept, name)
    );

    CREATE TABLE IF NOT EXISTS routes (
      id          SERIAL PRIMARY KEY,
      dept        TEXT NOT NULL,
      name        TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      item_names  JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS counts (
      dept        TEXT NOT NULL,
      item_name   TEXT NOT NULL,
      shelf       NUMERIC,
      cooler      NUMERIC,
      qty         NUMERIC,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dept, item_name)
    );

    CREATE TABLE IF NOT EXISTS session_state (
      dept        TEXT PRIMARY KEY,
      day_key     TEXT NOT NULL DEFAULT 'mon',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_history (
      id          SERIAL PRIMARY KEY,
      dept        TEXT NOT NULL,
      vendor      TEXT NOT NULL,
      day_label   TEXT,
      order_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      items       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id     SERIAL PRIMARY KEY,
      dept   TEXT NOT NULL,
      name   TEXT NOT NULL,
      UNIQUE (dept, name)
    );
  `);

  // Seed items only if the table is empty, so redeploys never clobber live data.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
  if (rows[0].n === 0) {
    console.log('Empty items table detected — seeding initial data.');
    await seedInitialData();
  } else {
    console.log(`Items table already has ${rows[0].n} rows — skipping seed.`);
  }
}

// Spreadsheet-sourced data occasionally carries values like " " or "10's" in a
// numeric column. Coerce defensively so a bad cell can never fail a deploy.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function seedInitialData() {
  const seedPath = path.join(__dirname, '..', 'seed_items.json');
  const routePath = path.join(__dirname, '..', 'seed_routes.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const routes = JSON.parse(fs.readFileSync(routePath, 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const dept of Object.keys(seed)) {
      let order = 0;
      for (const it of seed[dept]) {
        await client.query(
          `INSERT INTO items (dept, name, invdesc, vendor, case_size, unit, note, mode, shelf_target, pars, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (dept, name) DO NOTHING`,
          [dept, it.name, it.invdesc || '', it.vendor, num(it.case_size), it.unit, it.note,
           it.mode, num(it.shelf_target), JSON.stringify(it.pars || {}), order++]
        );
        if (it.vendor) {
          await client.query(
            `INSERT INTO vendors (dept, name) VALUES ($1,$2) ON CONFLICT (dept, name) DO NOTHING`,
            [dept, it.vendor]
          );
        }
      }
    }

    for (const dept of Object.keys(routes)) {
      let pos = 0;
      for (const g of routes[dept]) {
        await client.query(
          `INSERT INTO routes (dept, name, position, item_names) VALUES ($1,$2,$3,$4)`,
          [dept, g.name, pos++, JSON.stringify(g.items || [])]
        );
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
