import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const DEPTS = new Set(['produce', 'meat', 'fish']);
function checkDept(req, res) {
  const d = req.params.dept;
  if (!DEPTS.has(d)) { res.status(400).json({ error: 'unknown department' }); return null; }
  return d;
}

// ---- Bootstrap: everything the client needs for a department in one call ----
app.get('/api/:dept/bootstrap', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  try {
    const [items, routes, counts, session, vendors] = await Promise.all([
      pool.query('SELECT * FROM items WHERE dept=$1 ORDER BY sort_order, name', [dept]),
      pool.query('SELECT * FROM routes WHERE dept=$1 ORDER BY position', [dept]),
      pool.query('SELECT * FROM counts WHERE dept=$1', [dept]),
      pool.query('SELECT * FROM session_state WHERE dept=$1', [dept]),
      pool.query('SELECT name FROM vendors WHERE dept=$1 ORDER BY name', [dept])
    ]);
    res.json({
      items: items.rows,
      routes: routes.rows,
      counts: counts.rows,
      day: session.rows[0]?.day_key || null,
      vendors: vendors.rows.map(r => r.name)
    });
  } catch (e) {
    console.error('bootstrap failed', e);
    res.status(500).json({ error: 'bootstrap failed' });
  }
});

// ---- Counts: upsert a single item's count (called as you tap) ----
app.put('/api/:dept/count', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { item_name, shelf, cooler, qty } = req.body || {};
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  try {
    await pool.query(
      `INSERT INTO counts (dept, item_name, shelf, cooler, qty, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (dept, item_name)
       DO UPDATE SET shelf=EXCLUDED.shelf, cooler=EXCLUDED.cooler, qty=EXCLUDED.qty, updated_at=NOW()`,
      [dept, item_name, shelf ?? null, cooler ?? null, qty ?? null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('count save failed', e);
    res.status(500).json({ error: 'count save failed' });
  }
});

app.delete('/api/:dept/counts', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  try {
    await pool.query('DELETE FROM counts WHERE dept=$1', [dept]);
    res.json({ ok: true });
  } catch (e) {
    console.error('count clear failed', e);
    res.status(500).json({ error: 'count clear failed' });
  }
});

// ---- Session day ----
app.put('/api/:dept/day', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { day } = req.body || {};
  if (!day) return res.status(400).json({ error: 'day required' });
  try {
    await pool.query(
      `INSERT INTO session_state (dept, day_key, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (dept) DO UPDATE SET day_key=EXCLUDED.day_key, updated_at=NOW()`,
      [dept, day]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'day save failed' });
  }
});

// ---- Item updates: vendor, pars, shelf target, active flag ----
app.put('/api/:dept/item', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { name, vendor, vendor2, pars, shelf_target, active, note, invdesc } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const sets = [];
    const vals = [dept, name];
    let i = 3;
    if (vendor !== undefined)       { sets.push(`vendor=$${i++}`);       vals.push(vendor); }
    if (pars !== undefined)         { sets.push(`pars=$${i++}`);         vals.push(JSON.stringify(pars)); }
    if (shelf_target !== undefined) { sets.push(`shelf_target=$${i++}`); vals.push(shelf_target); }
    if (active !== undefined)       { sets.push(`active=$${i++}`);       vals.push(active); }
    if (note !== undefined)         { sets.push(`note=$${i++}`);         vals.push(note); }
    if (invdesc !== undefined)      { sets.push(`invdesc=$${i++}`);      vals.push(invdesc); }
    if (vendor2 !== undefined)      { sets.push(`vendor2=$${i++}`);      vals.push(vendor2 || null); }
    if (!sets.length) return res.json({ ok: true });
    await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE dept=$1 AND name=$2`, vals);
    res.json({ ok: true });
  } catch (e) {
    console.error('item update failed', e);
    res.status(500).json({ error: 'item update failed' });
  }
});

// Create an item. New produce is counted shelf+cooler like the rest of the
// department; everything else is a single count.
app.post('/api/:dept/item', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { name, invdesc, vendor } = req.body || {};
  const clean = (name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name required' });
  try {
    const mode = dept === 'produce' ? 'shelf_cooler' : 'single';
    const shelfTarget = dept === 'produce' ? 1 : null;
    const { rows } = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM items WHERE dept=$1', [dept]);
    const ins = await pool.query(
      `INSERT INTO items (dept, name, invdesc, vendor, mode, shelf_target, pars, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7)
       ON CONFLICT (dept, name) DO NOTHING
       RETURNING id`,
      [dept, clean, (invdesc || '').trim(), vendor || null, mode, shelfTarget, rows[0].n]
    );
    if (!ins.rowCount) return res.status(409).json({ error: 'that item already exists' });
    if (vendor) {
      await pool.query(
        `INSERT INTO vendors (dept, name) VALUES ($1,$2) ON CONFLICT (dept, name) DO NOTHING`,
        [dept, vendor]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('item create failed', e);
    res.status(500).json({ error: 'item create failed' });
  }
});

// Bulk vendor reassignment (e.g. every old "WESTLAKE" item -> "TITO'S")
app.put('/api/:dept/items/bulk-vendor', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { names, vendor } = req.body || {};
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'names required' });
  try {
    await pool.query(
      `UPDATE items SET vendor=$3 WHERE dept=$1 AND name = ANY($2::text[])`,
      [dept, names, vendor ?? null]
    );
    res.json({ ok: true, updated: names.length });
  } catch (e) {
    console.error('bulk vendor failed', e);
    res.status(500).json({ error: 'bulk vendor failed' });
  }
});

// ---- Vendors ----
app.post('/api/:dept/vendor', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query(
      `INSERT INTO vendors (dept, name) VALUES ($1,$2) ON CONFLICT (dept, name) DO NOTHING`,
      [dept, name.trim().toUpperCase()]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'vendor add failed' });
  }
});

// ---- Routes (walking order) ----
app.put('/api/:dept/routes', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { groups } = req.body || {};
  if (!Array.isArray(groups)) return res.status(400).json({ error: 'groups required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM routes WHERE dept=$1', [dept]);
    let pos = 0;
    for (const g of groups) {
      await client.query(
        `INSERT INTO routes (dept, name, position, item_names) VALUES ($1,$2,$3,$4)`,
        [dept, g.name, pos++, JSON.stringify(g.items || [])]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('routes save failed', e);
    res.status(500).json({ error: 'routes save failed' });
  } finally {
    client.release();
  }
});

// ---- Order history ----
app.post('/api/:dept/order', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  const { vendor, day_label, items } = req.body || {};
  if (!vendor) return res.status(400).json({ error: 'vendor required' });
  try {
    await pool.query(
      `INSERT INTO order_history (dept, vendor, day_label, items) VALUES ($1,$2,$3,$4)`,
      [dept, vendor, day_label || null, JSON.stringify(items || [])]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('order log failed', e);
    res.status(500).json({ error: 'order log failed' });
  }
});

app.get('/api/:dept/orders', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM order_history WHERE dept=$1 ORDER BY created_at DESC LIMIT 300`, [dept]
    );
    res.json({ orders: rows });
  } catch (e) {
    res.status(500).json({ error: 'orders fetch failed' });
  }
});

// Everything in the database as one JSON file. Worth taking before anything
// destructive — clearing a department to reseed it, most of all, which is the
// only routine operation here that actually removes rows.
app.get('/api/export', async (_req, res) => {
  try {
    const [items, counts, routes, vendors, orders, session] = await Promise.all([
      pool.query('SELECT * FROM items ORDER BY dept, sort_order, name'),
      pool.query('SELECT * FROM counts ORDER BY dept, item_name'),
      pool.query('SELECT * FROM routes ORDER BY dept, position'),
      pool.query('SELECT * FROM vendors ORDER BY dept, name'),
      pool.query('SELECT * FROM order_history ORDER BY created_at'),
      pool.query('SELECT * FROM session_state')
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="dat-moi-backup-${stamp}.json"`);
    res.send(JSON.stringify({
      exported_at: new Date().toISOString(),
      counts_summary: {
        items: items.rowCount, counts: counts.rowCount, routes: routes.rowCount,
        vendors: vendors.rowCount, orders: orders.rowCount
      },
      items: items.rows, counts: counts.rows, routes: routes.rows,
      vendors: vendors.rows, order_history: orders.rows, session_state: session.rows
    }, null, 1));
  } catch (e) {
    console.error('export failed', e);
    res.status(500).json({ error: 'export failed' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Dat Moi ordering running on :${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed', err);
    process.exit(1);
  });
