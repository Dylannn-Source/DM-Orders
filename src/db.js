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
// Present but blank is a different problem from absent, and the two used to be
// reported identically — confusingly so, since the variable is right there in
// the dashboard looking set.
const BLANK_VARS = URL_VARS.filter(v => v in process.env && !(process.env[v] || '').trim());
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
  if (/^\{\{.*\}\}$/.test(v)) {
    return [
      `${URL_VAR} is missing the leading $ that makes it a Railway reference:`,
      `    ${v}      <- what is set`,
      `    $${v}      <- what Railway substitutes`,
      '',
      'Railway only expands ${{...}}. Without the dollar sign the value is passed',
      'through as plain text, so the variable looks correct in the dashboard but',
      'never resolves. Edit it and put a $ at the front.'
    ];
  }
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
    ...(BLANK_VARS.length ? [
      `${BLANK_VARS.join(' and ')} exists here, but Railway is injecting it empty.`,
      '',
      'An empty value means the reference resolved to nothing: it points at a',
      'database service that does not exist under that name. Either it was never',
      'created, or it was renamed or deleted after the variable was written. The',
      'dashboard still shows the variable, which is what makes this so easy to miss.',
      ''
    ] : [
      'No database connection string found, so there is nothing to connect to.',
      `Checked: ${URL_VARS.join(', ')}.`,
      ''
    ]),
    'To fix it, Railway needs a database for the reference to point at:',
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
    '',
    '--- where this process is actually running ---',
    `  service:     ${process.env.RAILWAY_SERVICE_NAME || '(not on Railway)'}`,
    `  environment: ${process.env.RAILWAY_ENVIRONMENT_NAME || '(unknown)'}`,
    `  deployed:    ${process.env.RAILWAY_DEPLOYMENT_ID || '(unknown)'}`,
    // Names only, never values — this log may be shared.
    `  database-ish variables visible here: ${
      Object.keys(process.env).filter(k => /DATA|POSTGRES|\bPG/i.test(k)).sort().join(', ') || 'none'
    }`,
    '',
    'If "service" above is your database rather than the app, the variable went on',
    'the wrong box. If "environment" is not the one you edited, switch to it first.',
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
      vendor2       TEXT,
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

    -- The offsite warehouse is stock, not a count. A department's counts are a
    -- scratch pad wiped at the end of each ordering round; this is the standing
    -- record of what is out there, and Reset must never touch it.
    CREATE TABLE IF NOT EXISTS warehouse_stock (
      item_name   TEXT PRIMARY KEY,
      qty         NUMERIC NOT NULL DEFAULT 0,
      unit        TEXT,
      note        TEXT,
      counted_at  TIMESTAMPTZ,
      counted_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Every change, so "who took the last two cases" has an answer.
    CREATE TABLE IF NOT EXISTS warehouse_moves (
      id         SERIAL PRIMARY KEY,
      item_name  TEXT NOT NULL,
      kind       TEXT NOT NULL,          -- counted | added | taken | removed
      delta      NUMERIC,
      qty_after  NUMERIC NOT NULL,
      note       TEXT,
      moved_by   TEXT,
      moved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS warehouse_moves_at ON warehouse_moves (moved_at DESC);

    -- A mirror of Vori's on-hand, kept in step by polling. Vori counts every unit
    -- the business owns; the warehouse table counts one location, and the
    -- difference is what should be at the store.
    CREATE TABLE IF NOT EXISTS vori_inventory (
      product_id       TEXT PRIMARY KEY,
      on_hand          NUMERIC,
      vori_updated_at  TIMESTAMPTZ,
      synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- The warehouse is organised by category, and a category occupies one pallet
    -- or several. Position is the order you walk them, so counting follows your
    -- feet rather than the alphabet.
    CREATE TABLE IF NOT EXISTS warehouse_categories (
      name      TEXT PRIMARY KEY,
      pallets   TEXT,
      position  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS employees (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      pin_hash        TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'staff',
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_pin BOOLEAN NOT NULL DEFAULT TRUE,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until    TIMESTAMPTZ,
      last_login_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (name)
    );

    -- Which areas a person may change. Anyone signed in can read everything;
    -- these rows are only about editing. A manager needs no rows — the role
    -- carries the lot.
    CREATE TABLE IF NOT EXISTS employee_areas (
      employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      area         TEXT NOT NULL,
      PRIMARY KEY (employee_id, area)
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id     SERIAL PRIMARY KEY,
      dept   TEXT NOT NULL,
      name   TEXT NOT NULL,
      UNIQUE (dept, name)
    );
  `);

  // CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a column added
  // later has to be introduced separately for databases already out there.
  await pool.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS vendor2 TEXT');
  // Who counted it and who sent the order. Added separately so databases that
  // predate them pick them up without losing anything already recorded.
  await pool.query('ALTER TABLE counts ADD COLUMN IF NOT EXISTS counted_by TEXT');
  await pool.query('ALTER TABLE order_history ADD COLUMN IF NOT EXISTS placed_by TEXT');
  // Most warehouse stock moves by the case, but people pick at some of it — a
  // few bottles off a pallet. Cases and loose units are counted separately,
  // because "5 cases and 9 bottles" is what is on the shelf and 5.375 is not.
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS pack_size NUMERIC');
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS unit_name TEXT');
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS qty_units NUMERIC NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE warehouse_moves ADD COLUMN IF NOT EXISTS delta_units NUMERIC');
  await pool.query('ALTER TABLE warehouse_moves ADD COLUMN IF NOT EXISTS units_after NUMERIC');
  // A container holds pallets, and a pallet holds items. Slot is where a pallet
  // stands along the container; level is how high it is stacked, 0 on the floor
  // and 1 for one sitting on top of it. Together they are the plan of the room,
  // which is what makes "where exactly is it" answerable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warehouse_pallets (
      id         SERIAL PRIMARY KEY,
      location   TEXT NOT NULL,
      container  TEXT NOT NULL,
      label      TEXT,
      slot       INTEGER NOT NULL DEFAULT 0,
      level      INTEGER NOT NULL DEFAULT 0,
      note       TEXT,
      UNIQUE (location, container, slot, level)
    )`);
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS pallet_id INTEGER');
  // Which end of the pallet it is on. Null where it does not matter.
  await pool.query(`ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS layer TEXT`);

  // Which Vori product a warehouse line is, and what it is called there — free
  // text names cannot be matched to product ids on their own.
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS vori_product_id TEXT');
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS vori_name TEXT');
  await pool.query('ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS category TEXT');

  // The offsite warehouse and the cold storage containers are the same shape:
  // stock held somewhere other than the shop floor, divided into physical
  // sections. One set of tables carries both, keyed by location, so staleness,
  // cases-and-loose, movements, Vori links and permissions come for free rather
  // than being written twice.
  for (const t of ['warehouse_stock', 'warehouse_moves', 'warehouse_categories']) {
    await pool.query(
      `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'warehouse'`);
  }
  // Widen the keys so the same item name can exist in two places. Guarded, since
  // ALTER ... ADD PRIMARY KEY has no IF NOT EXISTS.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouse_stock_pkey' AND conkey = ARRAY[
                    (SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'warehouse_stock'::regclass AND attname = 'item_name')]) THEN
        ALTER TABLE warehouse_stock DROP CONSTRAINT warehouse_stock_pkey;
        ALTER TABLE warehouse_stock ADD PRIMARY KEY (location, item_name);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'warehouse_categories_pkey' AND conkey = ARRAY[
                    (SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'warehouse_categories'::regclass AND attname = 'name')]) THEN
        ALTER TABLE warehouse_categories DROP CONSTRAINT warehouse_categories_pkey;
        ALTER TABLE warehouse_categories ADD PRIMARY KEY (location, name);
      END IF;
    END $$;`);

  await seedEmptyDepartments();
}

// Seed per department rather than all-or-nothing. A department holding rows is
// never touched, so redeploys still cannot clobber live data, but a department
// that is empty — a new one, or one not filled in yet — gets its starting list
// instead of waiting for the whole database to be wiped.
async function seedEmptyDepartments() {
  const seedPath = path.join(__dirname, '..', 'seed_items.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const { rows } = await pool.query(
    'SELECT dept, COUNT(*)::int AS n FROM items GROUP BY dept');
  const have = Object.fromEntries(rows.map(r => [r.dept, r.n]));

  const empty = Object.keys(seed).filter(d => !have[d] && seed[d].length);
  const kept = Object.keys(have).filter(d => have[d]);
  if (kept.length) console.log(`Leaving alone: ${kept.map(d => `${d} (${have[d]})`).join(', ')}.`);
  if (!empty.length) { console.log('No empty departments to seed.'); return; }
  console.log(`Seeding empty departments: ${empty.join(', ')}.`);
  await seedInitialData(empty);
}

// Spreadsheet-sourced data occasionally carries values like " " or "10's" in a
// numeric column. Coerce defensively so a bad cell can never fail a deploy.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function seedInitialData(depts) {
  const seedPath = path.join(__dirname, '..', 'seed_items.json');
  const routePath = path.join(__dirname, '..', 'seed_routes.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const routes = JSON.parse(fs.readFileSync(routePath, 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const dept of Object.keys(seed).filter(d => depts.includes(d))) {
      let order = 0;
      for (const it of seed[dept]) {
        await client.query(
          `INSERT INTO items (dept, name, invdesc, vendor, vendor2, case_size, unit, note, mode, shelf_target, pars, active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (dept, name) DO NOTHING`,
          [dept, it.name, it.invdesc || '', it.vendor, it.vendor2 || null,
           num(it.case_size), it.unit, it.note, it.mode, num(it.shelf_target),
           JSON.stringify(it.pars || {}), it.active !== false, order++]
        );
        if (it.vendor) {
          await client.query(
            `INSERT INTO vendors (dept, name) VALUES ($1,$2) ON CONFLICT (dept, name) DO NOTHING`,
            [dept, it.vendor]
          );
        }
      }
    }

    for (const dept of Object.keys(routes).filter(d => depts.includes(d))) {
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
