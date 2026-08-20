import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, initDb } from './db.js';
import {
  hashPin, verifyPin, isValidPin, issueSession, clearSession, currentEmployee,
  lockState, noteFailure, noteSuccess, ipThrottled, MAX_FAILURES, LOCK_MINUTES
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- who is signed in ------------------------------------------------------
// Everything under /api needs a session except signing in itself, and the
// first-run setup that exists only while there are no employees at all.
const OPEN_PATHS = new Set(['/api/auth/whoami', '/api/auth/login', '/api/auth/setup']);

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/') || OPEN_PATHS.has(req.path)) return next();
  try {
    const me = await currentEmployee(req);
    if (!me) return res.status(401).json({ error: 'sign in first' });
    if (me.must_change_pin && req.path !== '/api/auth/change-pin') {
      return res.status(403).json({ error: 'choose a new PIN first', must_change_pin: true });
    }
    req.employee = me;
    next();
  } catch (e) {
    console.error('auth check failed', e);
    res.status(500).json({ error: 'auth check failed' });
  }
});

function managerOnly(req, res) {
  if (req.employee?.role !== 'manager') {
    res.status(403).json({ error: 'managers only' });
    return false;
  }
  return true;
}

async function employeeCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM employees WHERE active');
  return rows[0].n;
}

const publicEmployee = e => ({
  id: e.id, name: e.name, role: e.role, active: e.active,
  must_change_pin: e.must_change_pin, locked: lockState(e).locked,
  locked_minutes: lockState(e).minutes || null, last_login_at: e.last_login_at || null
});

// Who am I, and if nobody yet, does this app still need setting up?
app.get('/api/auth/whoami', async (req, res) => {
  try {
    const me = await currentEmployee(req);
    const n = await employeeCount();
    if (!n) return res.json({ needs_setup: true, employee: null, names: [] });
    const { rows } = await pool.query(
      'SELECT id, name FROM employees WHERE active ORDER BY name');
    res.json({
      needs_setup: false,
      employee: me ? publicEmployee(me) : null,
      names: rows
    });
  } catch (e) {
    console.error('whoami failed', e);
    res.status(500).json({ error: 'whoami failed' });
  }
});

// Creating the first manager. Only possible while no employee exists, which is
// what stops it being a way in later.
app.post('/api/auth/setup', async (req, res) => {
  try {
    if (await employeeCount()) return res.status(409).json({ error: 'already set up' });
    const { name, pin } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'name required' });
    const bad = isValidPin(pin);
    if (bad) return res.status(400).json({ error: bad });
    const { rows } = await pool.query(
      `INSERT INTO employees (name, pin_hash, role, must_change_pin)
       VALUES ($1,$2,'manager',FALSE) RETURNING *`,
      [String(name).trim(), hashPin(pin)]);
    await issueSession(res, rows[0]);
    res.json({ ok: true, employee: publicEmployee(rows[0]) });
  } catch (e) {
    console.error('setup failed', e);
    res.status(500).json({ error: 'setup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (ipThrottled(req)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    const { employee_id, pin } = req.body || {};
    const { rows } = await pool.query(
      'SELECT * FROM employees WHERE id=$1 AND active', [employee_id]);
    const emp = rows[0];
    // Same reply whether the name or the PIN was wrong, so neither can be probed.
    const nope = () => res.status(401).json({ error: 'That PIN is not right.' });
    if (!emp) return nope();

    const lock = lockState(emp);
    if (lock.locked) {
      return res.status(423).json({
        error: `Too many wrong tries. Try again in ${lock.minutes} minute${lock.minutes === 1 ? '' : 's'}, or ask a manager to reset it.`
      });
    }
    if (!verifyPin(pin, emp.pin_hash)) {
      const after = await noteFailure(emp.id);
      const left = MAX_FAILURES - after.failed_attempts;
      if (left <= 0) {
        return res.status(423).json({
          error: `Too many wrong tries. Locked for ${LOCK_MINUTES} minutes, or ask a manager to reset it.`
        });
      }
      return res.status(401).json({
        error: `That PIN is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      });
    }
    await noteSuccess(emp.id);
    await issueSession(res, emp);
    const fresh = { ...emp, failed_attempts: 0, locked_until: null };
    res.json({ ok: true, employee: publicEmployee(fresh) });
  } catch (e) {
    console.error('login failed', e);
    res.status(500).json({ error: 'login failed' });
  }
});

app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

app.post('/api/auth/change-pin', async (req, res) => {
  try {
    const me = await currentEmployee(req);
    if (!me) return res.status(401).json({ error: 'sign in first' });
    const { current_pin, new_pin } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM employees WHERE id=$1', [me.id]);
    const emp = rows[0];
    if (!verifyPin(current_pin, emp.pin_hash)) {
      return res.status(401).json({ error: 'That current PIN is not right.' });
    }
    const bad = isValidPin(new_pin);
    if (bad) return res.status(400).json({ error: bad });
    if (verifyPin(new_pin, emp.pin_hash)) {
      return res.status(400).json({ error: 'That is the PIN you already had.' });
    }
    await pool.query(
      'UPDATE employees SET pin_hash=$2, must_change_pin=FALSE, failed_attempts=0, locked_until=NULL WHERE id=$1',
      [me.id, hashPin(new_pin)]);
    res.json({ ok: true });
  } catch (e) {
    console.error('change pin failed', e);
    res.status(500).json({ error: 'change pin failed' });
  }
});

// ---- employees, for managers ----------------------------------------------
app.get('/api/employees', async (req, res) => {
  if (!managerOnly(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT * FROM employees ORDER BY active DESC, name');
    res.json({ employees: rows.map(publicEmployee) });
  } catch (e) { res.status(500).json({ error: 'employees fetch failed' }); }
});

app.post('/api/employees', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const { name, pin, role } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name required' });
  // A manager-set PIN is temporary and may be short — the last four of a phone
  // number is the usual choice. It has to be changed at first sign-in.
  const bad = isValidPin(pin, { allowShort: true });
  if (bad) return res.status(400).json({ error: bad });
  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (name, pin_hash, role, must_change_pin)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [String(name).trim(), hashPin(pin), role === 'manager' ? 'manager' : 'staff']);
    if (!rows[0]) return res.status(409).json({ error: 'someone already has that name' });
    res.json({ ok: true, employee: publicEmployee(rows[0]) });
  } catch (e) {
    console.error('employee create failed', e);
    res.status(500).json({ error: 'employee create failed' });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const id = Number(req.params.id);
  const { pin, active, role } = req.body || {};
  try {
    if (pin !== undefined) {
      const bad = isValidPin(pin, { allowShort: true });
      if (bad) return res.status(400).json({ error: bad });
      // Resetting also clears a lockout: forgetting and being locked out are the
      // same problem to the person standing there.
      await pool.query(
        `UPDATE employees SET pin_hash=$2, must_change_pin=TRUE, failed_attempts=0, locked_until=NULL
          WHERE id=$1`, [id, hashPin(pin)]);
    }
    if (active !== undefined) {
      if (!active && id === req.employee.id) {
        return res.status(400).json({ error: 'You cannot switch off your own account.' });
      }
      if (!active) {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM employees WHERE active AND role='manager' AND id<>$1`, [id]);
        const { rows: who } = await pool.query('SELECT role FROM employees WHERE id=$1', [id]);
        if (who[0]?.role === 'manager' && rows[0].n === 0) {
          return res.status(400).json({ error: 'That is the last manager — promote someone else first.' });
        }
      }
      await pool.query('UPDATE employees SET active=$2 WHERE id=$1', [id, !!active]);
    }
    if (role !== undefined) {
      if (role !== 'manager' && id === req.employee.id) {
        return res.status(400).json({ error: 'You cannot remove your own manager rights.' });
      }
      await pool.query('UPDATE employees SET role=$2 WHERE id=$1',
        [id, role === 'manager' ? 'manager' : 'staff']);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('employee update failed', e);
    res.status(500).json({ error: 'employee update failed' });
  }
});

// ---- offsite warehouse ------------------------------------------------------
// Few people go there and not often, so a quantity is only as good as its age.
// Every response carries how long ago each number was last confirmed, and the
// screen leans on that rather than on the number alone.
app.get('/api/warehouse', async (_req, res) => {
  try {
    const [stock, moves] = await Promise.all([
      pool.query(`SELECT *, EXTRACT(EPOCH FROM (NOW() - counted_at))/86400 AS days_since_count
                    FROM warehouse_stock ORDER BY item_name`),
      pool.query(`SELECT * FROM warehouse_moves ORDER BY moved_at DESC LIMIT 60`)
    ]);
    res.json({ stock: stock.rows, moves: moves.rows });
  } catch (e) {
    console.error('warehouse fetch failed', e);
    res.status(500).json({ error: 'warehouse fetch failed' });
  }
});

app.post('/api/warehouse/item', async (req, res) => {
  const { name, unit, qty } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name required' });
  const start = Number(qty) || 0;
  try {
    const ins = await pool.query(
      `INSERT INTO warehouse_stock (item_name, unit, qty, counted_at, counted_by)
       VALUES ($1,$2,$3,NOW(),$4)
       ON CONFLICT (item_name) DO NOTHING RETURNING item_name`,
      [clean, String(unit || '').trim() || null, start, req.employee.name]);
    if (!ins.rowCount) return res.status(409).json({ error: 'that is already on the list' });
    await pool.query(
      `INSERT INTO warehouse_moves (item_name, kind, delta, qty_after, moved_by)
       VALUES ($1,'counted',NULL,$2,$3)`, [clean, start, req.employee.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('warehouse add failed', e);
    res.status(500).json({ error: 'warehouse add failed' });
  }
});

// One route for all three movements. "counted" sets the number and is the only
// one that refreshes its age — adding or taking a case tells you the stock moved,
// not that anyone looked at the shelf.
app.put('/api/warehouse/move', async (req, res) => {
  const { item_name, kind, qty, note } = req.body || {};
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  if (!['counted', 'added', 'taken'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be counted, added or taken' });
  }
  const n = Number(qty);
  if (!isFinite(n) || n < 0) return res.status(400).json({ error: 'quantity must be a number' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT qty FROM warehouse_stock WHERE item_name=$1 FOR UPDATE', [item_name]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not on the list' }); }
    const before = Number(rows[0].qty);
    const after = kind === 'counted' ? n
                : kind === 'added'   ? before + n
                : Math.max(before - n, 0);
    const delta = kind === 'counted' ? null : after - before;
    await client.query(
      kind === 'counted'
        ? `UPDATE warehouse_stock SET qty=$2, counted_at=NOW(), counted_by=$3, updated_at=NOW() WHERE item_name=$1`
        : `UPDATE warehouse_stock SET qty=$2, updated_at=NOW() WHERE item_name=$1`,
      kind === 'counted' ? [item_name, after, req.employee.name] : [item_name, after]);
    await client.query(
      `INSERT INTO warehouse_moves (item_name, kind, delta, qty_after, note, moved_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [item_name, kind, delta, after, String(note || '').trim() || null, req.employee.name]);
    await client.query('COMMIT');
    res.json({ ok: true, qty: after });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('warehouse move failed', e);
    res.status(500).json({ error: 'warehouse move failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/warehouse/item/:name', async (req, res) => {
  if (!managerOnly(req, res)) return;
  try {
    const { rows } = await pool.query(
      'DELETE FROM warehouse_stock WHERE item_name=$1 RETURNING qty', [req.params.name]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    await pool.query(
      `INSERT INTO warehouse_moves (item_name, kind, delta, qty_after, moved_by)
       VALUES ($1,'removed',NULL,0,$2)`, [req.params.name, req.employee.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('warehouse delete failed', e);
    res.status(500).json({ error: 'warehouse delete failed' });
  }
});

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
      `INSERT INTO counts (dept, item_name, shelf, cooler, qty, counted_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (dept, item_name)
       DO UPDATE SET shelf=EXCLUDED.shelf, cooler=EXCLUDED.cooler, qty=EXCLUDED.qty,
                     counted_by=EXCLUDED.counted_by, updated_at=NOW()`,
      [dept, item_name, shelf ?? null, cooler ?? null, qty ?? null, req.employee.name]
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
      `INSERT INTO order_history (dept, vendor, day_label, items, placed_by) VALUES ($1,$2,$3,$4,$5)`,
      [dept, vendor, day_label || null, JSON.stringify(items || []), req.employee.name]
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
app.get('/api/export', async (req, res) => {
  // The whole database in one file, so it stays with managers rather than
  // anyone who can sign in on the floor.
  if (!managerOnly(req, res)) return;
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
