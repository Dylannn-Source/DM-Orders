import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function initDb() {
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
