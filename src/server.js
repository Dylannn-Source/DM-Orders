import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, initDb } from './db.js';
import {
  hashPin, verifyPin, isValidPin, issueSession, clearSession, currentEmployee,
  lockState, noteFailure, noteSuccess, ipThrottled, MAX_FAILURES, LOCK_MINUTES
} from './auth.js';
import { syncInventory, voriStatus, searchProducts, voriConfigured } from './vori.js';

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
    req.areas = await areasFor(me);
    next();
  } catch (e) {
    console.error('auth check failed', e);
    res.status(500).json({ error: 'auth check failed' });
  }
});

// Anyone signed in can read anything. Changing something needs the area granted,
// which a manager has by role. Enforced here rather than in the browser: hiding a
// button is a courtesy, this is the actual rule.
const AREAS = ['produce', 'meat', 'fish', 'warehouse', 'coldstorage'];

async function areasFor(employee) {
  if (!employee) return [];
  if (employee.role === 'manager') return [...AREAS];
  const { rows } = await pool.query(
    'SELECT area FROM employee_areas WHERE employee_id=$1', [employee.id]);
  return rows.map(r => r.area);
}

function canWrite(req, res, area) {
  if (req.employee?.role === 'manager') return true;
  if ((req.areas || []).includes(area)) return true;
  res.status(403).json({
    error: `You can look at ${area}, but changing it is not yours to do. Ask a manager.`,
    area, read_only: true
  });
  return false;
}

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

const publicEmployee = (e, areas) => ({
  id: e.id, name: e.name, role: e.role, active: e.active,
  must_change_pin: e.must_change_pin, locked: lockState(e).locked,
  locked_minutes: lockState(e).minutes || null, last_login_at: e.last_login_at || null,
  areas: areas || (e.role === 'manager' ? [...AREAS] : [])
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
      employee: me ? publicEmployee(me, await areasFor(me)) : null,
      names: rows,
      areas: AREAS
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
    res.json({ ok: true, employee: publicEmployee(fresh, await areasFor(emp)) });
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
    const grants = await pool.query('SELECT employee_id, area FROM employee_areas');
    const byId = {};
    grants.rows.forEach(g => (byId[g.employee_id] = byId[g.employee_id] || []).push(g.area));
    res.json({
      employees: rows.map(e => publicEmployee(e, e.role === 'manager' ? [...AREAS] : (byId[e.id] || []))),
      areas: AREAS
    });
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
  const { pin, active, role, areas } = req.body || {};
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
    if (Array.isArray(areas)) {
      const wanted = areas.filter(a => AREAS.includes(a));
      await pool.query('DELETE FROM employee_areas WHERE employee_id=$1', [id]);
      for (const a of wanted) {
        await pool.query(
          `INSERT INTO employee_areas (employee_id, area) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`, [id, a]);
      }
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

// ---- stock held away from the shop floor ------------------------------------
// Two places, one shape: the offsite warehouse divided into pallets, and the
// cold storage containers at MonkishZ. Same tables keyed by location, so both
// get staleness, cases-and-loose, movements, Vori links and permissions from one
// implementation rather than two that drift apart.
const PLACES = new Set(['warehouse', 'coldstorage']);
function checkPlace(req, res) {
  const loc = req.params.loc;
  if (!PLACES.has(loc)) { res.status(400).json({ error: 'unknown place' }); return null; }
  return loc;
}

app.get('/api/place/:loc', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  try {
    const [stock, moves, vori, cats] = await Promise.all([
      pool.query(`SELECT w.*,
                         EXTRACT(EPOCH FROM (NOW() - w.counted_at))/86400 AS days_since_count,
                         v.on_hand      AS vori_on_hand,
                         v.synced_at    AS vori_synced_at,
                         EXTRACT(EPOCH FROM (NOW() - v.synced_at))/3600 AS vori_hours_old,
                         h.held_all, h.held_here, h.no_pack, h.places
                    FROM warehouse_stock w
                    LEFT JOIN vori_inventory v ON v.product_id = w.vori_product_id
                    -- Vori counts every unit the business owns, so what is left
                    -- for the store is its number less everything held anywhere
                    -- else. Subtracting only the place on screen overstates the
                    -- store by whatever is sitting in the other one.
                    LEFT JOIN (
                      SELECT vori_product_id,
                             SUM(CASE WHEN pack_size IS NOT NULL
                                      THEN qty * pack_size + COALESCE(qty_units,0) END) AS held_all,
                             SUM(CASE WHEN pack_size IS NOT NULL AND location = $1
                                      THEN qty * pack_size + COALESCE(qty_units,0) END) AS held_here,
                             COUNT(*) FILTER (WHERE pack_size IS NULL)      AS no_pack,
                             COUNT(DISTINCT location)                       AS places
                        FROM warehouse_stock
                       WHERE vori_product_id IS NOT NULL
                       GROUP BY vori_product_id
                    ) h ON h.vori_product_id = w.vori_product_id
                   WHERE w.location = $1
                   ORDER BY w.item_name`, [loc]),
      pool.query(`SELECT * FROM warehouse_moves WHERE location=$1 ORDER BY moved_at DESC LIMIT 60`, [loc]),
      voriStatus().catch(() => ({ configured: false })),
      pool.query('SELECT * FROM warehouse_categories WHERE location=$1 ORDER BY position, name', [loc])
    ]);
    const pallets = await pool.query(
      'SELECT * FROM warehouse_pallets WHERE location=$1 ORDER BY container, slot, level', [loc]);
    res.json({ location: loc, stock: stock.rows, moves: moves.rows, vori,
               categories: cats.rows, pallets: pallets.rows });
  } catch (e) {
    console.error('place fetch failed', e);
    res.status(500).json({ error: 'could not load that place' });
  }
});

app.post('/api/place/:loc/item', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { name, unit, qty, pack_size, unit_name, qty_units, category } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name required' });
  const pack = Number(pack_size) > 0 ? Number(pack_size) : null;
  const cases = Number(qty) || 0;
  const units = pack ? (Number(qty_units) || 0) : 0;
  const cat = String(category || '').trim() || null;
  try {
    const ins = await pool.query(
      `INSERT INTO warehouse_stock
         (location, item_name, unit, qty, pack_size, unit_name, qty_units, category, counted_at, counted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
       ON CONFLICT (location, item_name) DO NOTHING RETURNING item_name`,
      [loc, clean, String(unit || '').trim() || null, cases, pack,
       pack ? (String(unit_name || '').trim() || 'units') : null, units, cat, req.employee.name]);
    if (!ins.rowCount) return res.status(409).json({ error: 'that is already on the list' });
    if (cat) await ensureCategory(loc, cat);
    await pool.query(
      `INSERT INTO warehouse_moves (location, item_name, kind, delta, qty_after, units_after, moved_by)
       VALUES ($1,$2,'counted',NULL,$3,$4,$5)`, [loc, clean, cases, units, req.employee.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('place add failed', e);
    res.status(500).json({ error: 'could not add that' });
  }
});

// A container has a fixed number of pallet spots and they exist whether or not
// anything is on them — an empty spot is a place to put something, not an absence
// to be created first.
const SPOTS_PER_CONTAINER = 8;
async function ensureSpots(loc, container, upTo = SPOTS_PER_CONTAINER) {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(slot), -1) AS max FROM warehouse_pallets WHERE location=$1 AND container=$2',
    [loc, container]);
  for (let slot = Number(rows[0].max) + 1; slot < upTo; slot++) {
    await pool.query(
      `INSERT INTO warehouse_pallets (location, container, label, slot, level)
       VALUES ($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`,
      [loc, container, String(slot + 1), slot]);
  }
}

app.post('/api/place/:loc/spots', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const cont = String(req.body?.container || '').trim();
  if (!cont) return res.status(400).json({ error: 'which container?' });
  try {
    const extra = Number(req.body?.add) > 0 ? Number(req.body.add) : 0;
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM warehouse_pallets WHERE location=$1 AND container=$2', [loc, cont]);
    await ensureSpots(loc, cont, extra ? rows[0].n + extra : SPOTS_PER_CONTAINER);
    res.json({ ok: true });
  } catch (e) {
    console.error('spots failed', e);
    res.status(500).json({ error: 'could not set those up' });
  }
});

// Fill one level of one pallet: a quantity and a product, or blank to clear it.
app.put('/api/place/:loc/pallet/:id/level/:level', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const id = Number(req.params.id);
  const level = Number(req.params.level);
  if (![0, 1, 2].includes(level)) return res.status(400).json({ error: 'level must be 0, 1 or 2' });
  const name = String(req.body?.name || '').trim();
  const qty = Number(req.body?.qty);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pal } = await client.query(
      'SELECT container FROM warehouse_pallets WHERE id=$1 AND location=$2', [id, loc]);
    if (!pal[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no such pallet' }); }

    // Whatever was on this level comes off, whether or not something replaces it.
    await client.query(
      'UPDATE warehouse_stock SET pallet_id=NULL, stack_pos=NULL WHERE pallet_id=$1 AND stack_pos=$2',
      [id, level]);

    if (name) {
      if (!isFinite(qty) || qty < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'how many?' }); }
      // The product may be new here, may already be on another pallet, or may be
      // sitting in the container unplaced. One upsert covers all three.
      await client.query(
        `INSERT INTO warehouse_stock (location, item_name, unit, qty, category, pallet_id, stack_pos, counted_at, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
         ON CONFLICT (location, item_name) DO UPDATE
           SET qty=EXCLUDED.qty, category=EXCLUDED.category, pallet_id=EXCLUDED.pallet_id,
               stack_pos=EXCLUDED.stack_pos, counted_at=NOW(), counted_by=EXCLUDED.counted_by,
               updated_at=NOW()`,
        [loc, name, String(req.body?.unit || '').trim() || null, qty, pal[0].container, id, level, req.employee.name]);
      await client.query(
        `INSERT INTO warehouse_moves (location, item_name, kind, delta, qty_after, moved_by)
         VALUES ($1,$2,'counted',NULL,$3,$4)`, [loc, name, qty, req.employee.name]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('level set failed', e);
    res.status(500).json({ error: 'could not save that' });
  } finally { client.release(); }
});

async function ensureCategory(loc, name) {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM warehouse_categories WHERE location=$1', [loc]);
  await pool.query(
    `INSERT INTO warehouse_categories (location, name, position) VALUES ($1,$2,$3)
     ON CONFLICT (location, name) DO NOTHING`, [loc, name, rows[0].n]);
}

// Describes the item rather than its quantity, so it is kept apart from moves.
app.put('/api/place/:loc/item/:name', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { pack_size, unit_name, unit } = req.body || {};
  const pack = Number(pack_size) > 0 ? Number(pack_size) : null;
  try {
    const { rows } = await pool.query(
      // Every parameter is cast: a bare $2 tested with IS NULL leaves Postgres no
      // way to infer its type and the statement is rejected outright.
      `UPDATE warehouse_stock
          SET pack_size = $3::numeric,
              unit_name = CASE WHEN $3::numeric IS NULL THEN NULL
                               ELSE COALESCE($4::text, unit_name, 'units') END,
              unit = COALESCE($5::text, unit),
              qty_units = CASE WHEN $3::numeric IS NULL THEN 0 ELSE qty_units END,
              updated_at = NOW()
        WHERE location = $1::text AND item_name = $2::text RETURNING item_name`,
      [loc, req.params.name, pack, String(unit_name || '').trim() || null,
       String(unit || '').trim() || null]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true });
  } catch (e) {
    console.error('place item update failed', e);
    res.status(500).json({ error: 'could not update that' });
  }
});

// One route for all three movements. "counted" sets the number and is the only
// one that refreshes its age — adding or taking a case tells you the stock moved,
// not that anyone looked at the shelf.
app.put('/api/place/:loc/move', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { item_name, kind, cases, units, note } = req.body || {};
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  if (!['counted', 'added', 'taken'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be counted, added or taken' });
  }
  const c = Number(cases) || 0;
  const u = Number(units) || 0;
  if (![c, u].every(n => isFinite(n) && n >= 0)) {
    return res.status(400).json({ error: 'quantities must be numbers' });
  }
  if (kind !== 'counted' && c === 0 && u === 0) {
    return res.status(400).json({ error: 'say how many' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT qty, qty_units, pack_size FROM warehouse_stock WHERE location=$1 AND item_name=$2 FOR UPDATE',
      [loc, item_name]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not on the list' }); }
    const pack = rows[0].pack_size === null ? null : Number(rows[0].pack_size);
    const beforeC = Number(rows[0].qty), beforeU = Number(rows[0].qty_units);

    let afterC, afterU;
    if (kind === 'counted') {
      // Recorded as seen. Five stacked cases and thirty loose bottles is what is
      // on the shelf, so it is not quietly restated as six cases and six.
      afterC = c; afterU = pack ? u : 0;
    } else if (kind === 'added') {
      afterC = beforeC + c; afterU = pack ? beforeU + u : 0;
    } else {
      afterC = beforeC - c; afterU = pack ? beforeU - u : 0;
      // Nobody loose left and someone wants three bottles: open a case, which is
      // exactly what happens out there.
      while (pack && afterU < 0 && afterC > 0) { afterC -= 1; afterU += pack; }
      afterC = Math.max(afterC, 0); afterU = Math.max(afterU, 0);
    }

    await client.query(
      kind === 'counted'
        ? `UPDATE warehouse_stock SET qty=$3, qty_units=$4, counted_at=NOW(), counted_by=$5, updated_at=NOW()
            WHERE location=$1 AND item_name=$2`
        : `UPDATE warehouse_stock SET qty=$3, qty_units=$4, updated_at=NOW()
            WHERE location=$1 AND item_name=$2`,
      kind === 'counted' ? [loc, item_name, afterC, afterU, req.employee.name]
                         : [loc, item_name, afterC, afterU]);
    await client.query(
      `INSERT INTO warehouse_moves (location, item_name, kind, delta, delta_units, qty_after, units_after, note, moved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [loc, item_name, kind,
       kind === 'counted' ? null : afterC - beforeC,
       kind === 'counted' ? null : afterU - beforeU,
       afterC, afterU, String(note || '').trim() || null, req.employee.name]);
    await client.query('COMMIT');
    res.json({ ok: true, qty: afterC, qty_units: afterU });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('place move failed', e);
    res.status(500).json({ error: 'could not record that' });
  } finally {
    client.release();
  }
});

// ---- pallets standing inside a container ----
app.post('/api/place/:loc/pallet', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { container, label, stack_on_slot } = req.body || {};
  const cont = String(container || '').trim();
  if (!cont) return res.status(400).json({ error: 'which container?' });
  try {
    let slot, level;
    if (stack_on_slot !== undefined && stack_on_slot !== null && stack_on_slot !== '') {
      // Stacking onto an existing slot: sit one level above whatever is highest.
      slot = Number(stack_on_slot);
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(level), -1) + 1 AS n FROM warehouse_pallets WHERE location=$1 AND container=$2 AND slot=$3',
        [loc, cont, slot]);
      level = rows[0].n;
    } else {
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(slot), -1) + 1 AS n FROM warehouse_pallets WHERE location=$1 AND container=$2',
        [loc, cont]);
      slot = rows[0].n; level = 0;
    }
    const { rows } = await pool.query(
      `INSERT INTO warehouse_pallets (location, container, label, slot, level)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [loc, cont, String(label || '').trim() || null, slot, level]);
    res.json({ ok: true, pallet: rows[0] });
  } catch (e) {
    console.error('pallet create failed', e);
    res.status(500).json({ error: 'could not add that pallet' });
  }
});

// Rearranging the plan to match the room: along the container, or up and down a
// stack. A swap rather than a renumber, so nothing else shifts underneath.
app.put('/api/place/:loc/pallet/:id', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const id = Number(req.params.id);
  const { label, note, move } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: me } = await client.query(
      'SELECT * FROM warehouse_pallets WHERE id=$1 AND location=$2 FOR UPDATE', [id, loc]);
    if (!me[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no such pallet' }); }
    const p = me[0];
    if (label !== undefined || note !== undefined) {
      await client.query(
        'UPDATE warehouse_pallets SET label=COALESCE($2::text,label), note=COALESCE($3::text,note) WHERE id=$1',
        [id, label === undefined ? null : (String(label).trim() || null),
             note === undefined ? null : (String(note).trim() || null)]);
    }
    if (move) {
      const dSlot = move === 'left' ? -1 : move === 'right' ? 1 : 0;
      const dLevel = move === 'down' ? -1 : move === 'up' ? 1 : 0;
      const nSlot = p.slot + dSlot, nLevel = p.level + dLevel;
      if (nSlot >= 0 && nLevel >= 0) {
        const { rows: other } = await client.query(
          'SELECT id FROM warehouse_pallets WHERE location=$1 AND container=$2 AND slot=$3 AND level=$4',
          [loc, p.container, nSlot, nLevel]);
        if (other[0]) {
          // Park one out of the way first: the unique key would otherwise reject
          // the halfway state where both claim the same square.
          await client.query('UPDATE warehouse_pallets SET slot=-1, level=-1 WHERE id=$1', [p.id]);
          await client.query('UPDATE warehouse_pallets SET slot=$2, level=$3 WHERE id=$1', [other[0].id, p.slot, p.level]);
          await client.query('UPDATE warehouse_pallets SET slot=$2, level=$3 WHERE id=$1', [p.id, nSlot, nLevel]);
        } else {
          await client.query('UPDATE warehouse_pallets SET slot=$2, level=$3 WHERE id=$1', [p.id, nSlot, nLevel]);
        }
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('pallet update failed', e);
    res.status(500).json({ error: 'could not move that pallet' });
  } finally { client.release(); }
});

app.delete('/api/place/:loc/pallet/:id', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  try {
    // Items outlive the pallet — they stay in the container, off any pallet.
    await pool.query('UPDATE warehouse_stock SET pallet_id=NULL, layer=NULL WHERE pallet_id=$1', [Number(req.params.id)]);
    await pool.query('DELETE FROM warehouse_pallets WHERE id=$1 AND location=$2', [Number(req.params.id), loc]);
    res.json({ ok: true });
  } catch (e) {
    console.error('pallet delete failed', e);
    res.status(500).json({ error: 'could not remove that pallet' });
  }
});

// Put an item on a pallet, and say which end of it.
app.put('/api/place/:loc/item/:name/pallet', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { pallet_id } = req.body || {};
  const pid = pallet_id ? Number(pallet_id) : null;
  try {
    // Goes on the bottom of the stack, which is where a pallet grows.
    let pos = null;
    if (pid) {
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(stack_pos), -1) + 1 AS n FROM warehouse_stock WHERE pallet_id=$1', [pid]);
      pos = rows[0].n;
    }
    const { rows } = await pool.query(
      `UPDATE warehouse_stock SET pallet_id=$3::integer, stack_pos=$4::integer, updated_at=NOW()
        WHERE location=$1::text AND item_name=$2::text RETURNING item_name`,
      [loc, req.params.name, pid, pos]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true });
  } catch (e) {
    console.error('item pallet failed', e);
    res.status(500).json({ error: 'could not move that' });
  }
});

// Shuffle an item up or down its own pallet, so the list reads in the order the
// things are actually stacked.
app.put('/api/place/:loc/item/:name/stack', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const dir = req.body?.move;
  if (!['up', 'down'].includes(dir)) return res.status(400).json({ error: 'move must be up or down' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: me } = await client.query(
      'SELECT item_name, pallet_id, stack_pos FROM warehouse_stock WHERE location=$1 AND item_name=$2 FOR UPDATE',
      [loc, req.params.name]);
    if (!me[0]?.pallet_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not on a pallet' }); }
    const { rows: mates } = await client.query(
      'SELECT item_name, stack_pos FROM warehouse_stock WHERE pallet_id=$1 ORDER BY stack_pos, item_name',
      [me[0].pallet_id]);
    const i = mates.findIndex(m => m.item_name === me[0].item_name);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < mates.length) {
      // Renumber the whole pallet from the swapped order: stack_pos may have
      // gaps or ties from earlier edits, and rewriting it makes them harmless.
      const order = [...mates];
      [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) {
        await client.query('UPDATE warehouse_stock SET stack_pos=$2 WHERE location=$3 AND item_name=$1',
          [order[k].item_name, k, loc]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('stack move failed', e);
    res.status(500).json({ error: 'could not reorder that' });
  } finally { client.release(); }
});

// ---- sections: pallets in the warehouse, containers in cold storage ----
app.post('/api/place/:loc/category', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { name, pallets } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS n FROM warehouse_categories WHERE location=$1`, [loc]);
    const ins = await pool.query(
      `INSERT INTO warehouse_categories (location, name, pallets, position) VALUES ($1,$2,$3,$4)
       ON CONFLICT (location, name) DO NOTHING RETURNING name`,
      [loc, clean, String(pallets || '').trim() || null, rows[0].n]);
    if (!ins.rowCount) return res.status(409).json({ error: 'that one already exists' });
    if (loc === 'coldstorage') await ensureSpots(loc, clean);
    res.json({ ok: true });
  } catch (e) {
    console.error('category create failed', e);
    res.status(500).json({ error: 'could not add that' });
  }
});

app.put('/api/place/:loc/category/:name', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { pallets, move } = req.body || {};
  try {
    if (pallets !== undefined) {
      await pool.query(
        'UPDATE warehouse_categories SET pallets=$3::text WHERE location=$1::text AND name=$2::text',
        [loc, req.params.name, String(pallets || '').trim() || null]);
    }
    // Swap positions with the neighbour, so the walking order can be nudged
    // without renumbering everything.
    if (move === 'up' || move === 'down') {
      const { rows } = await pool.query(
        'SELECT name, position FROM warehouse_categories WHERE location=$1 ORDER BY position, name', [loc]);
      const i = rows.findIndex(r => r.name === req.params.name);
      const j = move === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < rows.length) {
        await pool.query('UPDATE warehouse_categories SET position=$3 WHERE location=$1 AND name=$2', [loc, rows[i].name, j]);
        await pool.query('UPDATE warehouse_categories SET position=$3 WHERE location=$1 AND name=$2', [loc, rows[j].name, i]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('category update failed', e);
    res.status(500).json({ error: 'could not update that' });
  }
});

app.delete('/api/place/:loc/category/:name', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!managerOnly(req, res)) return;
  try {
    // Items outlive their section — they fall back to the unassigned pile rather
    // than disappearing with it.
    await pool.query(
      'UPDATE warehouse_stock SET category=NULL WHERE location=$1::text AND category=$2::text',
      [loc, req.params.name]);
    await pool.query('DELETE FROM warehouse_categories WHERE location=$1::text AND name=$2::text',
      [loc, req.params.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('category delete failed', e);
    res.status(500).json({ error: 'could not remove that' });
  }
});

app.put('/api/place/:loc/item/:name/category', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const cat = String(req.body?.category || '').trim() || null;
  try {
    if (cat) await ensureCategory(loc, cat);
    const { rows } = await pool.query(
      'UPDATE warehouse_stock SET category=$3::text, updated_at=NOW() WHERE location=$1::text AND item_name=$2::text RETURNING item_name',
      [loc, req.params.name, cat]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true });
  } catch (e) {
    console.error('item category failed', e);
    res.status(500).json({ error: 'could not move that' });
  }
});

app.put('/api/place/:loc/item/:name/vori', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const { vori_product_id, vori_name } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE warehouse_stock SET vori_product_id=$3::text, vori_name=$4::text, updated_at=NOW()
        WHERE location=$1::text AND item_name=$2::text RETURNING item_name`,
      [loc, req.params.name, vori_product_id || null, vori_name || null]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true });
  } catch (e) {
    console.error('vori link failed', e);
    res.status(500).json({ error: 'could not link that' });
  }
});

app.delete('/api/place/:loc/item/:name', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!managerOnly(req, res)) return;
  try {
    const { rows } = await pool.query(
      'DELETE FROM warehouse_stock WHERE location=$1::text AND item_name=$2::text RETURNING qty', [loc, req.params.name]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    await pool.query(
      `INSERT INTO warehouse_moves (location, item_name, kind, delta, qty_after, moved_by)
       VALUES ($1,$2,'removed',NULL,0,$3)`, [loc, req.params.name, req.employee.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('place delete failed', e);
    res.status(500).json({ error: 'could not remove that' });
  }
});
// ---- Vori ------------------------------------------------------------------
// Read-only. Nothing in this app writes to Vori, and the key it uses should be
// scoped read-only too.
app.get('/api/vori/status', async (_req, res) => {
  try { res.json(await voriStatus()); }
  catch (e) { res.status(500).json({ error: 'vori status failed' }); }
});

app.post('/api/vori/sync', async (req, res) => {
  if (!managerOnly(req, res)) return;
  if (!voriConfigured()) {
    return res.status(400).json({
      error: 'No Vori API key set. Add VORI_API_KEY in Railway, then deploy.'
    });
  }
  try {
    const out = await syncInventory({ full: !!req.body?.full });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('vori sync failed', e);
    res.status(502).json({ error: String(e.message || e).slice(0, 300) });
  }
});

app.get('/api/vori/search', async (req, res) => {
  if (!voriConfigured()) return res.status(400).json({ error: 'No Vori API key set.' });
  try { res.json({ products: await searchProducts(req.query.q) }); }
  catch (e) {
    console.error('vori search failed', e);
    res.status(502).json({ error: String(e.message || e).slice(0, 300) });
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
  if (!canWrite(req, res, dept)) return;
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
// Poll Vori on a timer so the numbers stay current without anyone remembering
// to press Sync. Only quantities that actually moved come back, so this is cheap.
function startVoriPolling() {
  if (!voriConfigured()) {
    console.log('No VORI_API_KEY set — Vori on-hand will not be shown.');
    return;
  }
  const minutes = Math.max(5, Number(process.env.VORI_SYNC_MINUTES) || 30);
  const run = () => syncInventory()
    .then(r => console.log(`Vori sync: ${r.records} products` +
      (r.quantityField ? ` (quantity read from "${r.quantityField}")` : '')))
    // A failed poll is not fatal — the last mirrored numbers stay, marked with
    // their age, and the next run tries the same window again.
    .catch(e => console.error('Vori sync failed:', e.message));
  setTimeout(run, 10_000);
  setInterval(run, minutes * 60_000);
  console.log(`Vori sync every ${minutes} minutes.`);
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Dat Moi ordering running on :${PORT}`));
    startVoriPolling();
  })
  .catch(err => {
    console.error('DB init failed', err);
    process.exit(1);
  });
