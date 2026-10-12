import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, initDb } from './db.js';
import {
  hashPin, verifyPin, isValidPin, issueSession, clearSession, currentEmployee,
  lockState, noteFailure, noteSuccess, ipThrottled, MAX_FAILURES, LOCK_MINUTES
} from './auth.js';
import { syncInventory, voriStatus, searchProducts, voriConfigured } from './vori.js';
import { startFryWatch, matchFryPayments, fryVoriStatus } from './fry.js';
import { syncSheet, sheetStatus, sheetsConfigured, noteSheetError } from './sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
// The worker itself is never cached by the browser. A stale sw.js would pin the
// app to an old build indefinitely, which is the classic way this goes wrong.
app.use('/sw.js', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });
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

// What each area is called on screen. The stored names never change.
const AREA_LABELS = { warehouse: 'the offsite warehouse', coldstorage: 'Monkish' };

function canWrite(req, res, area) {
  if (req.employee?.role === 'manager') return true;
  if ((req.areas || []).includes(area)) return true;
  res.status(403).json({
    error: `You can look at ${AREA_LABELS[area] || area}, but changing it is not yours to do. Ask a manager.`,
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
  must_change_pin: e.must_change_pin, simple_mode: !!e.simple_mode,
  locked: lockState(e).locked,
  locked_minutes: lockState(e).minutes || null, last_login_at: e.last_login_at || null,
  areas: areas || (e.role === 'manager' ? [...AREAS] : [])
});

// Who am I, and if nobody yet, does this app still need setting up?
app.get('/api/auth/whoami', async (req, res) => {
  try {
    const me = await currentEmployee(req);
    const n = await employeeCount();
    if (!n) return res.json({ needs_setup: true, employee: null, names: [] });
    // Only people who can actually sign in. The roster also holds staff who have
    // no PIN and never open this app, and offering their name on the login
    // screen is offering a door that opens onto nothing.
    const { rows } = await pool.query(
      'SELECT id, name FROM employees WHERE active AND pin_hash IS NOT NULL ORDER BY name');
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

// ---- fried fish -----------------------------------------------------------
//
// One ticket per fish, from the counter to the oil. The number on it is what
// the clerk writes on the customer's slip, so the person at the register can
// find the same ticket without reading anything back to anybody.
const FRY_STEPS = ['waiting', 'paid', 'frying', 'done'];

function fryRow(t) {
  return {
    id: t.id, number: t.number, fish: t.fish,
    weight: t.weight === null ? null : Number(t.weight),
    price: t.price === null ? null : Number(t.price),
    prep: t.prep, status: t.status,
    created_by: t.created_by, created_at: t.created_at,
    plu: t.plu, vori_product_id: t.vori_product_id,
    paid_by: t.paid_by, paid_at: t.paid_at, paid_source: t.paid_source,
    vori_txn: t.vori_txn,
    fried_by: t.fried_by, fried_at: t.fried_at, done_at: t.done_at,
    void_reason: t.void_reason
  };
}

// Everything today, plus the fish names already in the fish department so the
// clerk picks rather than spells.
app.get('/api/fry/board', async (req, res) => {
  try {
    const [tickets, fish] = await Promise.all([
      pool.query(`SELECT * FROM fry_tickets WHERE day = CURRENT_DATE ORDER BY number`),
      pool.query(`SELECT plu, name, price_per_lb, vori_product_id, by_weight
                    FROM fry_products WHERE active ORDER BY name`)
    ]);
    res.json({
      tickets: tickets.rows.map(fryRow),
      fish: fish.rows.map(f => ({
        plu: f.plu, name: f.name, by_weight: f.by_weight,
        price_per_lb: f.price_per_lb === null ? null : Number(f.price_per_lb),
        vori_product_id: f.vori_product_id
      })),
      vori: fryVoriStatus(),
      me: req.employee?.name || null,
      now: new Date().toISOString()
    });
  } catch (e) {
    console.error('fry board failed', e);
    res.status(500).json({ error: 'could not load the board' });
  }
});

// A fish goes on the board. The number is the next one today, worked out inside
// the insert so two clerks at two counters cannot both be handed the same one.
app.post('/api/fry/ticket', async (req, res) => {
  const fish = String(req.body?.fish || '').trim();
  if (!fish) return res.status(400).json({ error: 'Which fish?' });
  const n = v => (v === null || v === undefined || String(v).trim() === '') ? null : Number(v);
  const weight = n(req.body?.weight), price = n(req.body?.price);
  if (weight !== null && !(weight >= 0)) return res.status(400).json({ error: 'That weight is not a number.' });
  if (price !== null && !(price >= 0)) return res.status(400).json({ error: 'That price is not a number.' });
  const prep = String(req.body?.prep || '').trim() || null;
  // The PLU is what ties the ticket to the line the cashier will ring. Without
  // it the fish still goes on the board, it just has to be tapped paid by hand.
  let plu = String(req.body?.plu || '').trim() || null, productId = null;
  if (plu) {
    const { rows: f } = await pool.query(
      'SELECT plu, vori_product_id FROM fry_products WHERE plu=$1', [plu]);
    if (!f[0]) plu = null; else productId = f[0].vori_product_id;
  }
  // The unique index is the referee. On the rare collision, take the next one.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO fry_tickets (day, number, fish, weight, price, prep, created_by,
                                   plu, vori_product_id)
         SELECT CURRENT_DATE,
                COALESCE((SELECT MAX(number) FROM fry_tickets WHERE day = CURRENT_DATE), 0) + 1,
                $1, $2::numeric, $3::numeric, $4, $5, $6, $7
         RETURNING *`,
        [fish, weight, price, prep, req.employee.name, plu, productId]);
      return res.json({ ok: true, ticket: fryRow(rows[0]) });
    } catch (e) {
      if (e.code === '23505') continue;     // somebody took that number; try again
      console.error('fry ticket failed', e);
      return res.status(500).json({ error: 'could not add that fish' });
    }
  }
  res.status(503).json({ error: 'The counter is busy. Try that again.' });
});

// Ask Vori now rather than waiting for the next sweep. What the fryer presses
// when they are standing there and the board has not caught up yet.
app.post('/api/fry/check', async (req, res) => {
  const out = await matchFryPayments();
  res.json({ ok: true, ...out, vori: fryVoriStatus() });
});

// Moving a ticket along. Each step records who and when, because "it is paid"
// with nobody's name on it is exactly the pile of paper this replaces.
app.post('/api/fry/ticket/:id/:action', async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.params.action);
  const who = req.employee.name;
  try {
    const { rows: found } = await pool.query('SELECT * FROM fry_tickets WHERE id=$1', [id]);
    const t = found[0];
    if (!t) return res.status(404).json({ error: 'no such ticket' });

    // Every step names the status it is moving away from, and that status is in
    // the WHERE clause rather than only in a check above it. Two fryers tapping
    // "into the oil" on the same fish both read 'paid', both pass a check, and
    // both get told yes -- and the fish is fried twice. Postgres settles it:
    // the second update matches no row and is told what actually happened.
    let sql, vals, from;
    if (action === 'paid') {
      from = 'waiting';
      sql = `UPDATE fry_tickets SET status='paid', paid_by=$2, paid_at=NOW(),
               paid_source='cashier', updated_at=NOW()
             WHERE id=$1 AND status='waiting' RETURNING *`;
      vals = [id, who];
    } else if (action === 'frying') {
      // Only a paid fish goes in the oil. This is the whole point of the board,
      // so it is refused here and not merely greyed out on a screen.
      from = 'paid';
      sql = `UPDATE fry_tickets SET status='frying', fried_by=$2, fried_at=NOW(),
               updated_at=NOW() WHERE id=$1 AND status='paid' RETURNING *`;
      vals = [id, who];
    } else if (action === 'done') {
      from = 'frying';
      sql = `UPDATE fry_tickets SET status='done', done_at=NOW(), updated_at=NOW()
               WHERE id=$1 AND status='frying' RETURNING *`;
      vals = [id];
    } else if (action === 'undo') {
      // A wrong tap during a rush, put back one step. Nothing is erased: the
      // name and time of the step being undone are cleared, and the board is
      // what it was a moment ago.
      const at = FRY_STEPS.indexOf(t.status);
      if (at <= 0) return res.status(409).json({ error: `#${t.number} is already at the start.` });
      const back = FRY_STEPS[at - 1];
      from = t.status;
      sql = `UPDATE fry_tickets SET status=$3, updated_at=NOW(),
               paid_by   = CASE WHEN $3='waiting' THEN NULL ELSE paid_by END,
               paid_at   = CASE WHEN $3='waiting' THEN NULL ELSE paid_at END,
               paid_source = CASE WHEN $3='waiting' THEN NULL ELSE paid_source END,
               fried_by  = CASE WHEN $3 IN ('waiting','paid') THEN NULL ELSE fried_by END,
               fried_at  = CASE WHEN $3 IN ('waiting','paid') THEN NULL ELSE fried_at END,
               done_at   = NULL
             WHERE id=$1 AND status=$2 RETURNING *`;
      vals = [id, t.status, back];
    } else if (action === 'void') {
      from = t.status;
      if (t.status === 'void') return res.status(409).json({ error: 'already cancelled' });
      sql = `UPDATE fry_tickets SET status='void', void_reason=$3, updated_at=NOW()
               WHERE id=$1 AND status=$2 RETURNING *`;
      vals = [id, t.status, String(req.body?.reason || '').trim() || `cancelled by ${who}`];
    } else {
      return res.status(400).json({ error: 'unknown action' });
    }
    const { rows } = await pool.query(sql, vals);
    if (!rows[0]) {
      // Somebody got there first. Say what it is now, not what it was.
      const { rows: now } = await pool.query('SELECT status, number FROM fry_tickets WHERE id=$1', [id]);
      const at = now[0]?.status || 'gone';
      return res.status(409).json({
        error: action === 'frying' && at === 'waiting'
          ? `#${t.number} is not paid for yet.`
          : `#${t.number} is ${at} already.`,
        status: at
      });
    }
    res.json({ ok: true, ticket: fryRow(rows[0]) });
  } catch (e) {
    console.error('fry ticket update failed', e);
    res.status(500).json({ error: 'could not change that ticket' });
  }
});

// ---- time off: vacation and sick hours ------------------------------------
//
// The balance is never stored. It is the sum of the ledger, worked out on every
// read, because the question people actually ask is not "how many hours do I
// have" but "how did it get to that" -- and the only answer to the second one
// is the list of what happened.
const KINDS = ['vacation', 'sick'];
const okKind = k => KINDS.includes(String(k));

// Everyone may see their own. Only a manager may see anybody else's: hours
// taken sick are nobody else's business.
function timeOffScope(req, res, employeeId) {
  if (req.employee?.role === 'manager') return true;
  if (Number(employeeId) === Number(req.employee?.id)) return true;
  res.status(403).json({ error: 'Your own time off is yours to see. Everyone else’s is a manager’s.' });
  return false;
}

const num = v => (v === null || v === undefined || String(v).trim() === '') ? null : Number(v);
// Hours somebody types land on quarters. A time off form says 8, or 4, or 7.5,
// and a typed 7.3333 is a typo.
//
// Accruals are not rounded this way. A rate is legitimately 3.08 a period, or
// an hour per thirty worked, and snapping that to a quarter takes roughly two
// hours a year off everybody's vacation -- which in California is earned wages,
// so rounding it away is not a display quirk. Accrued hours are stored exactly
// and only rounded when they are drawn on screen.
const qtr = v => Math.round(Number(v) * 4) / 4;
// Money-ish precision, and enough for an hour per thirty worked.
const exact = v => Math.round(Number(v) * 10000) / 10000;

// The roster with a balance against each name. A manager sees everybody; anyone
// else sees themselves, so the tab is worth opening either way.
app.get('/api/timeoff/roster', async (req, res) => {
  try {
    const mine = req.employee?.role === 'manager' ? null : req.employee?.id;
    const { rows: people } = await pool.query(
      `SELECT id, name, active, hired_on, role, pin_hash IS NOT NULL AS can_login
         FROM employees ${mine ? 'WHERE id=$1' : ''}
        ORDER BY active DESC, name`, mine ? [mine] : []);
    const ids = people.map(p => p.id);
    const balances = {}, rates = {};
    if (ids.length) {
      const { rows: b } = await pool.query(
        `SELECT employee_id, kind, SUM(hours)::numeric AS hours
           FROM time_off_ledger WHERE employee_id = ANY($1) GROUP BY employee_id, kind`, [ids]);
      b.forEach(r => { (balances[r.employee_id] = balances[r.employee_id] || {})[r.kind] = Number(r.hours); });
      const { rows: r } = await pool.query(
        `SELECT * FROM time_off_rates WHERE employee_id = ANY($1)`, [ids]);
      r.forEach(x => { (rates[x.employee_id] = rates[x.employee_id] || {})[x.kind] = {
        basis: x.basis, rate: Number(x.rate), cap: x.cap === null ? null : Number(x.cap) }; });
    }
    res.json({
      manager: req.employee?.role === 'manager',
      kinds: KINDS,
      people: people.map(p => ({
        id: p.id, name: p.name, active: p.active, hired_on: p.hired_on,
        can_login: p.can_login,
        balances: { vacation: balances[p.id]?.vacation || 0, sick: balances[p.id]?.sick || 0 },
        rates: rates[p.id] || {}
      }))
    });
  } catch (e) {
    console.error('time off roster failed', e);
    res.status(500).json({ error: 'could not load the roster' });
  }
});

// One person: the balance, and every line that made it.
app.get('/api/timeoff/person/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!timeOffScope(req, res, id)) return;
  try {
    const { rows: who } = await pool.query(
      `SELECT id, name, active, hired_on FROM employees WHERE id=$1`, [id]);
    if (!who[0]) return res.status(404).json({ error: 'not on the roster' });
    const { rows: lines } = await pool.query(
      `SELECT * FROM time_off_ledger WHERE employee_id=$1
        ORDER BY on_date DESC, id DESC LIMIT 400`, [id]);
    const { rows: rates } = await pool.query(
      `SELECT * FROM time_off_rates WHERE employee_id=$1`, [id]);
    const bal = { vacation: 0, sick: 0 };
    const { rows: sums } = await pool.query(
      `SELECT kind, SUM(hours)::numeric AS hours FROM time_off_ledger
        WHERE employee_id=$1 GROUP BY kind`, [id]);
    sums.forEach(s => { bal[s.kind] = Number(s.hours); });
    res.json({
      person: who[0],
      balances: bal,
      rates: Object.fromEntries(rates.map(r => [r.kind,
        { basis: r.basis, rate: Number(r.rate), cap: r.cap === null ? null : Number(r.cap) }])),
      lines: lines.map(l => ({ ...l, hours: Number(l.hours) })),
      manager: req.employee?.role === 'manager'
    });
  } catch (e) {
    console.error('time off person failed', e);
    res.status(500).json({ error: 'could not load that person' });
  }
});

// Somebody on the roster who does not use the app. No PIN, so no way in.
app.post('/api/timeoff/person', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const name = String(req.body?.name || '').trim();
  const hired = String(req.body?.hired_on || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'A name is needed.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (name, pin_hash, role, must_change_pin, hired_on)
       VALUES ($1, NULL, 'staff', FALSE, $2::date)
       ON CONFLICT (name) DO NOTHING RETURNING id, name`, [name, hired]);
    if (!rows[0]) return res.status(409).json({ error: `${name} is already on the roster.` });
    res.json({ ok: true, person: rows[0] });
  } catch (e) {
    console.error('roster add failed', e);
    res.status(500).json({ error: 'could not add that person' });
  }
});

// What somebody earns. Three ways, because small shops use all of them: a set
// number of hours each pay period, a number per hour actually worked (which is
// how California sick leave is usually written), or a lump once a year.
app.put('/api/timeoff/rate/:id/:kind', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const id = Number(req.params.id);
  const kind = String(req.params.kind);
  if (!okKind(kind)) return res.status(400).json({ error: 'vacation or sick' });
  const basis = ['per_period', 'per_hour_worked', 'annual'].includes(req.body?.basis)
    ? req.body.basis : 'per_period';
  const rate = num(req.body?.rate) ?? 0;
  const cap = num(req.body?.cap);
  if (!isFinite(rate) || rate < 0) return res.status(400).json({ error: 'That rate is not a number.' });
  try {
    await pool.query(
      `INSERT INTO time_off_rates (employee_id, kind, basis, rate, cap)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (employee_id, kind) DO UPDATE
         SET basis=EXCLUDED.basis, rate=EXCLUDED.rate, cap=EXCLUDED.cap`,
      [id, kind, basis, rate, cap]);
    res.json({ ok: true });
  } catch (e) {
    console.error('rate save failed', e);
    res.status(500).json({ error: 'could not save that rate' });
  }
});

// A line on somebody's ledger: time taken off the form, an opening balance
// carried over from the spreadsheet, or a correction.
app.post('/api/timeoff/entry', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const id = Number(req.body?.employee_id);
  const kind = String(req.body?.kind);
  const hours = num(req.body?.hours);
  const on_date = String(req.body?.on_date || '').trim();
  const through = String(req.body?.through || '').trim() || null;
  const source = ['request', 'opening', 'adjustment'].includes(req.body?.source)
    ? req.body.source : 'request';
  if (!id || !okKind(kind)) return res.status(400).json({ error: 'Who, and vacation or sick?' });
  if (hours === null || !isFinite(hours) || hours === 0) {
    return res.status(400).json({ error: 'How many hours?' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on_date)) return res.status(400).json({ error: 'What date?' });
  try {
    // Time taken comes off. The screen asks for a plain number of hours, so the
    // sign is decided here by what kind of line it is rather than by hoping
    // somebody remembers to type a minus.
    const signed = source === 'request' ? -Math.abs(qtr(hours)) : qtr(hours);
    const { rows } = await pool.query(
      `INSERT INTO time_off_ledger (employee_id, kind, hours, on_date, through, reason, source, entered_by)
       VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8) RETURNING id`,
      [id, kind, signed, on_date, through, String(req.body?.reason || '').trim() || null,
       source, req.employee.name]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('time off entry failed', e);
    res.status(500).json({ error: 'could not save that' });
  }
});

// Nothing is deleted. A wrong line is answered with its opposite, so the
// history of how a balance moved survives being corrected.
app.post('/api/timeoff/reverse/:id', async (req, res) => {
  if (!managerOnly(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT * FROM time_off_ledger WHERE id=$1', [req.params.id]);
    const line = rows[0];
    if (!line) return res.status(404).json({ error: 'no such line' });
    if (line.source === 'reversal') return res.status(400).json({ error: 'That line is already a correction.' });
    const { rows: had } = await pool.query(
      `SELECT 1 FROM time_off_ledger WHERE source='reversal' AND reason LIKE $1`,
      [`%#${line.id}`]);
    if (had[0]) return res.status(409).json({ error: 'That line has already been taken back.' });
    await pool.query(
      `INSERT INTO time_off_ledger (employee_id, kind, hours, on_date, reason, source, entered_by)
       VALUES ($1,$2,$3,CURRENT_DATE,$4,'reversal',$5)`,
      [line.employee_id, line.kind, -Number(line.hours),
       `takes back #${line.id}`, req.employee.name]);
    res.json({ ok: true });
  } catch (e) {
    console.error('reversal failed', e);
    res.status(500).json({ error: 'could not take that back' });
  }
});

// Posting a pay period's accrual to everybody at once.
//
// Per-hour rates need the hours each person actually worked, which this app has
// no way of knowing, so they are typed in from payroll. Everything else the
// rate already answers. The unique index does the real work of stopping a
// period being posted twice -- two managers, two phones, same afternoon.
app.post('/api/timeoff/accrue', async (req, res) => {
  if (!managerOnly(req, res)) return;
  const on_date = String(req.body?.on_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on_date)) return res.status(400).json({ error: 'Which period end?' });
  const worked = req.body?.hours_worked && typeof req.body.hours_worked === 'object'
    ? req.body.hours_worked : {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: rates } = await client.query(
      `SELECT r.*, e.name FROM time_off_rates r
         JOIN employees e ON e.id = r.employee_id
        WHERE e.active AND r.rate > 0`);
    const posted = [], skipped = [], capped = [];
    for (const r of rates) {
      let hours = Number(r.rate);
      if (r.basis === 'per_hour_worked') {
        const w = num(worked[r.employee_id]);
        if (!w) { skipped.push(`${r.name} (${r.kind}): no hours worked given`); continue; }
        hours = Number(r.rate) * w;
      }
      hours = exact(hours);
      if (hours <= 0) continue;
      if (r.cap !== null) {
        const { rows: b } = await client.query(
          `SELECT COALESCE(SUM(hours),0)::numeric AS h FROM time_off_ledger
            WHERE employee_id=$1 AND kind=$2`, [r.employee_id, r.kind]);
        const room = Number(r.cap) - Number(b[0].h);
        if (room <= 0) { capped.push(`${r.name} (${r.kind})`); continue; }
        // Exactly the room left, never rounded up into it: rounding a partial
        // top-up to the nearest quarter can land above the cap it was there to
        // respect.
        if (hours > room) { hours = exact(room); capped.push(`${r.name} (${r.kind}), part only`); }
      }
      const { rows: ins } = await client.query(
        `INSERT INTO time_off_ledger (employee_id, kind, hours, on_date, reason, source, entered_by)
         VALUES ($1,$2,$3,$4::date,$5,'accrual',$6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [r.employee_id, r.kind, hours, on_date,
         `period ending ${on_date}`, req.employee.name]);
      if (ins[0]) posted.push(`${r.name} (${r.kind}): ${hours}`);
      else skipped.push(`${r.name} (${r.kind}): already posted for this period`);
    }
    await client.query('COMMIT');
    res.json({ ok: true, posted: posted.length, skipped, capped, detail: posted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('accrual failed', e);
    res.status(500).json({ error: 'could not post that period' });
  } finally {
    client.release();
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
  const { pin, active, role, areas, simple_mode } = req.body || {};
  try {
    if (pin !== undefined) {
      const bad = isValidPin(pin, { allowShort: true });
      if (bad) return res.status(400).json({ error: bad });
      // Normally a reset PIN is temporary and the person picks their own. Not for
      // a simple-mode account: being made to invent and type a six-digit code is
      // exactly the wall that account exists to avoid, and hitting it alone at
      // the storage unit ends the trip. The manager's PIN is the PIN. The account
      // can only record stock leaving a pallet, so there is nothing behind it
      // worth protecting with a ceremony he cannot complete.
      const { rows: who } = await pool.query('SELECT simple_mode FROM employees WHERE id=$1', [id]);
      const force = !who[0]?.simple_mode;
      // Resetting also clears a lockout: forgetting and being locked out are the
      // same problem to the person standing there.
      await pool.query(
        `UPDATE employees SET pin_hash=$2, must_change_pin=$3, failed_attempts=0, locked_until=NULL
          WHERE id=$1`, [id, hashPin(pin), force]);
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
    if (simple_mode !== undefined) {
      // A manager could lock themselves out of the rest of the app, so they
      // cannot put their own account into it.
      if (simple_mode && id === req.employee.id) {
        return res.status(400).json({ error: 'You cannot put your own account in simple mode.' });
      }
      // Switching it on also clears any pending forced PIN change, which would
      // otherwise be the first thing they hit and the one screen they cannot pass.
      await pool.query(
        `UPDATE employees SET simple_mode=$2, must_change_pin = CASE WHEN $2 THEN FALSE ELSE must_change_pin END
          WHERE id=$1`, [id, !!simple_mode]);
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
    const [stock, moves, vori, sheet, cats] = await Promise.all([
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
      loc === 'warehouse' ? sheetStatus().catch(() => ({ configured: false })) : Promise.resolve(null),
      pool.query('SELECT * FROM warehouse_categories WHERE location=$1 ORDER BY position, name', [loc])
    ]);
    const pallets = await pool.query(
      'SELECT * FROM warehouse_pallets WHERE location=$1 ORDER BY container, slot, level', [loc]);
    res.json({ location: loc, stock: stock.rows, moves: moves.rows, vori, sheet,
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
// Eight, and there is no more room in the container for a ninth. A hard number
// rather than a default, so nothing anywhere can quietly exceed the floor space.
const SPOTS_PER_CONTAINER = 8;
async function ensureSpots(loc, container) {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(slot), -1) AS max FROM warehouse_pallets WHERE location=$1 AND container=$2',
    [loc, container]);
  for (let slot = Number(rows[0].max) + 1; slot < SPOTS_PER_CONTAINER; slot++) {
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
    await ensureSpots(loc, cont);
    res.json({ ok: true, spots: SPOTS_PER_CONTAINER });
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
  // Levels count from the pallet deck upwards, as far as that pallet goes.
  const level = Number(req.params.level);
  const name = String(req.body?.name || '').trim();
  const qty = Number(req.body?.qty);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pal } = await client.query(
      'SELECT container, levels FROM warehouse_pallets WHERE id=$1 AND location=$2', [id, loc]);
    if (!pal[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no such pallet' }); }
    if (!Number.isInteger(level) || level < 1 || level > Number(pal[0].levels)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This pallet has rows 1 to ${pal[0].levels}.` });
    }

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

// Takes an optional client so a caller inside a transaction does not leave a
// category behind when its own work rolls back.
async function ensureCategory(loc, name, db = pool) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM warehouse_categories WHERE location=$1', [loc]);
  await db.query(
    `INSERT INTO warehouse_categories (location, name, position) VALUES ($1,$2,$3)
     ON CONFLICT (location, name) DO NOTHING`, [loc, name, rows[0].n]);
}

// A whole pickup in one request: everything loaded onto the van, in one
// transaction, stamped with one run id.
//
// It arrives as a batch rather than a line at a time because the phone doing the
// typing may have had no signal for the last twenty minutes. Whoever loaded the
// van types the run out there, and it is posted whenever the phone next reaches
// the network -- so this has to be replayable and it has to be all-or-nothing.
// The client sends a run id it generated itself; posting the same one twice
// returns the first result rather than taking the stock twice.
app.post('/api/place/:loc/pickup', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;

  const runId = String(req.body?.run_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runId)) return res.status(400).json({ error: 'run_id required' });
  const lines = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!lines) return res.status(400).json({ error: 'items required' });
  if (lines.length > 600) return res.status(400).json({ error: 'too many lines in one pickup' });
  const note = String(req.body?.note || '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A phone that lost the connection mid-post will send the same run again.
    const { rows: already } = await client.query(
      'SELECT COUNT(*)::int AS n FROM warehouse_moves WHERE run_id=$1', [runId]);
    if (already[0].n) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, already_recorded: true, lines: already[0].n });
    }

    const short = [];      // wanted more than the app thought was on the pallet
    const missing = [];    // no longer in the warehouse list at all
    let taken = 0;

    for (const line of lines) {
      const name = String(line?.name || '').trim();
      let cases = Number(line?.cases) || 0;
      let units = Number(line?.units) || 0;
      if (!name || (cases <= 0 && units <= 0)) continue;
      if (![cases, units].every(n => isFinite(n) && n >= 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${name}" needs a number.` });
      }

      const { rows } = await client.query(
        `SELECT qty, qty_units, pack_size FROM warehouse_stock
          WHERE location=$1 AND item_name=$2 FOR UPDATE`, [loc, name]);
      if (!rows[0]) { missing.push(name); continue; }

      const pack = rows[0].pack_size === null ? null : Number(rows[0].pack_size);
      const beforeC = Number(rows[0].qty), beforeU = Number(rows[0].qty_units);
      // Twenty-four packs of something that comes twenty-four to a case is one
      // case. Recording it as twenty-four loose would leave the pallet holding a
      // case that is not there and a pile of packs that is. Only possible where
      // somebody has said how many are in a case; where nobody has, the packs
      // stay packs and stay honest.
      if (pack && units >= pack) {
        const whole = Math.floor(units / pack);
        cases += whole;
        units -= whole * pack;
      }
      let afterC = beforeC - cases;
      // Loose is recorded whether or not anybody has said how many are in a case.
      // "Three cases and six packs" is a true statement about the pallet on its
      // own; the pack size is only needed to turn it into one number, and
      // throwing the six away to avoid an arithmetic we cannot do yet loses the
      // only record that somebody opened a box.
      let afterU = beforeU - units;
      // No loose left and somebody wants three bottles: open a case, which is
      // exactly what happens out there.
      while (pack && afterU < 0 && afterC > 0) { afterC -= 1; afterU += pack; }
      // Taking more than the app knew about means the count was stale, not that
      // the pickup was wrong. Say which ones so somebody can go and look.
      if (afterC < 0 || afterU < 0) {
        short.push({ name, thought: beforeC, took: cases,
                     thought_loose: beforeU, took_loose: units });
      }
      // The shelf cannot hold less than nothing, but the ledger records what was
      // actually carried out of the door. Deriving the delta from the floored
      // figure instead threw the difference away: six packs out of a box on a
      // pallet with no loose recorded came back as "took 0", which is the one
      // number we know to be false. The stock is an estimate until the next
      // count; the move is the fact.
      afterC = Math.max(afterC, 0); afterU = Math.max(afterU, 0);

      await client.query(
        `UPDATE warehouse_stock
            SET qty=$3, qty_units=$4,
                -- Anybody taking loose from this product proves it gets picked
                -- at, so the next person sees a packs control without anyone
                -- having configured one.
                pick_loose = pick_loose OR $5::boolean,
                updated_at=NOW()
          WHERE location=$1 AND item_name=$2`, [loc, name, afterC, afterU, units > 0]);
      await client.query(
        `INSERT INTO warehouse_moves
           (location, item_name, kind, delta, delta_units, qty_after, units_after, note, moved_by, run_id)
         VALUES ($1,$2,'taken',$3,$4,$5,$6,$7,$8,$9)`,
        [loc, name, -cases, -units, afterC, afterU, note, req.employee.name, runId]);
      taken++;
    }

    if (!taken) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing was filled in.' }); }
    await client.query('COMMIT');
    res.json({ ok: true, run_id: runId, lines: taken, short, missing });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('pickup failed', e);
    res.status(500).json({ error: 'could not record that pickup' });
  } finally {
    client.release();
  }
});

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

// The Vietnamese name for an item, and for a pallet. Typed in the app rather
// than only synced from the sheet, because the person who spots that a name is
// wrong is the person standing at the pallet, and they should be able to fix it
// there rather than tell somebody who will get to the spreadsheet on Friday.
app.put('/api/place/:loc/item/:name/vi', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const vi = String(req.body?.name_vi ?? '').trim() || null;
  try {
    const { rows } = await pool.query(
      `UPDATE warehouse_stock SET name_vi = $3::text, updated_at = NOW()
        WHERE location = $1::text AND item_name = $2::text RETURNING item_name`,
      [loc, req.params.name, vi]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true });
  } catch (e) {
    console.error('vietnamese name save failed', e);
    res.status(500).json({ error: 'could not save that name' });
  }
});

app.put('/api/place/:loc/category/:name/vi', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const vi = String(req.body?.name_vi ?? '').trim() || null;
  try {
    await pool.query(
      `UPDATE warehouse_categories SET name_vi = $3::text
        WHERE location = $1::text AND name = $2::text`,
      [loc, req.params.name, vi]);
    res.json({ ok: true });
  } catch (e) {
    console.error('vietnamese pallet name save failed', e);
    res.status(500).json({ error: 'could not save that name' });
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
// Rename a pallet, or change how many rows it has. Pallets are not all the same
// height, so the count belongs to each one.
const MAX_LEVELS = 12;
app.put('/api/place/:loc/pallet/:id', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const id = Number(req.params.id);
  const { label, note, rows: rowsChange } = req.body || {};
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

    if (rowsChange === 'add' || rowsChange === 'remove') {
      const now = Number(p.levels);
      if (rowsChange === 'add') {
        if (now >= MAX_LEVELS) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `A pallet cannot go above ${MAX_LEVELS} rows.` });
        }
        await client.query('UPDATE warehouse_pallets SET levels=$2 WHERE id=$1', [id, now + 1]);
      } else {
        if (now <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'A pallet needs at least one row.' });
        }
        // Taking a row away must not quietly unplace what is on it, so the top
        // row has to be emptied first.
        const { rows: occupied } = await client.query(
          'SELECT item_name FROM warehouse_stock WHERE pallet_id=$1 AND stack_pos=$2', [id, now]);
        if (occupied[0]) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Row ${now} still has ${occupied[0].item_name} on it. Clear it first.`
          });
        }
        await client.query('UPDATE warehouse_pallets SET levels=$2 WHERE id=$1', [id, now - 1]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('pallet update failed', e);
    res.status(500).json({ error: 'could not change that pallet' });
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

// What the storage unit should hold, and what the onsite warehouse next door
// should hold. Two different jobs -- one says order more from the vendor, the
// other says how much to bring back on the twice-weekly run -- so they are set
// and cleared independently. Blank means "no target", which is not the same as
// a target of zero.
app.put('/api/place/:loc/item/:name/par', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const read = v => {
    if (v === undefined) return undefined;               // not mentioned, leave it
    if (v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : NaN;
  };
  const par = read(req.body?.par);
  const onsite = read(req.body?.onsite_par);
  if (Number.isNaN(par) || Number.isNaN(onsite)) {
    return res.status(400).json({ error: 'A PAR has to be a number, or blank for no target.' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE warehouse_stock
          SET par        = CASE WHEN $3::boolean THEN $4::numeric ELSE par END,
              onsite_par = CASE WHEN $5::boolean THEN $6::numeric ELSE onsite_par END,
              updated_at = NOW()
        WHERE location = $1::text AND item_name = $2::text
        RETURNING par, onsite_par`,
      [loc, req.params.name, par !== undefined, par ?? null, onsite !== undefined, onsite ?? null]);
    if (!rows[0]) return res.status(404).json({ error: 'not on the list' });
    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error('par update failed', e);
    res.status(500).json({ error: 'could not save that target' });
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

// Whole-grid save for the table view: one request for the screen rather than one
// per cell, so a run of edits either all lands or none does.
app.put('/api/place/:loc/bulk', async (req, res) => {
  const loc = checkPlace(req, res); if (!loc) return;
  if (!canWrite(req, res, loc)) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'rows required' });
  if (rows.length > 500) return res.status(400).json({ error: 'too many rows at once' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let added = 0, changed = 0;
    for (const r of rows) {
      const name = String(r.name || '').trim();
      if (!name) continue;                       // a blank line is not an edit
      const was = String(r.was || '').trim();
      const qty = r.qty === '' || r.qty === null || r.qty === undefined ? null : Number(r.qty);
      if (qty !== null && (!isFinite(qty) || qty < 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${name}" needs a number, not "${r.qty}".` });
      }
      // Fields the caller did not send are left as they are, not blanked: the
      // grid shows a subset of the columns and must not wipe the rest.
      const unit = r.unit === undefined ? undefined : (String(r.unit || '').trim() || null);
      const cat = String(r.category || '').trim() || null;
      const brand = r.brand === undefined ? undefined : (String(r.brand || '').trim() || null);
      const par = r.par === undefined || String(r.par ?? '').trim() === ''
        ? null : Number(r.par);
      if (par !== null && (!isFinite(par) || par < 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `The PAR for "${name}" needs a number, not "${r.par}".` });
      }
      if (cat) await ensureCategory(loc, cat, client);

      if (was && was !== name) {
        // A rename collides if the new name is already on the list.
        const { rows: clash } = await client.query(
          'SELECT 1 FROM warehouse_stock WHERE location=$1 AND item_name=$2', [loc, name]);
        if (clash[0]) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `"${name}" is already on the list, so "${was}" cannot be renamed to it.` });
        }
        await client.query(
          'UPDATE warehouse_stock SET item_name=$3 WHERE location=$1 AND item_name=$2', [loc, was, name]);
      }

      // Read first so the move log records a real count, not a rename or a
      // retyped unit. Every parameter is cast: a bare $n tested with IS NULL
      // leaves Postgres nothing to infer a type from.
      const { rows: cur } = await client.query(
        'SELECT qty FROM warehouse_stock WHERE location=$1 AND item_name=$2', [loc, name]);
      const before = cur[0] ? Number(cur[0].qty) : null;
      const counted = qty !== null && qty !== before;

      if (cur[0]) {
        await client.query(
          `UPDATE warehouse_stock
              SET qty = COALESCE($3::numeric, qty),
                  unit = CASE WHEN $11::boolean THEN $4::text ELSE unit END,
                  category = $5::text,
                  par = $8::numeric,
                  brand = CASE WHEN $9::boolean THEN $10::text ELSE brand END,
                  counted_at = CASE WHEN $6::boolean THEN NOW() ELSE counted_at END,
                  counted_by = CASE WHEN $6::boolean THEN $7::text ELSE counted_by END,
                  updated_at = NOW()
            WHERE location=$1 AND item_name=$2`,
          [loc, name, qty, unit ?? null, cat, counted, req.employee.name,
           par, brand !== undefined, brand ?? null, unit !== undefined]);
        changed++;
      } else {
        await client.query(
          `INSERT INTO warehouse_stock (location, item_name, qty, unit, category, par, brand, counted_at, counted_by)
           VALUES ($1,$2,$3::numeric,$4::text,$5::text,$6::numeric,$7::text,NOW(),$8::text)`,
          [loc, name, qty ?? 0, unit ?? 'cases', cat, par, brand ?? null, req.employee.name]);
        added++;
      }

      if (counted || !cur[0]) {
        await client.query(
          `INSERT INTO warehouse_moves (location, item_name, kind, delta, qty_after, moved_by)
           VALUES ($1,$2,'counted',NULL,$3::numeric,$4::text)`,
          [loc, name, qty ?? 0, req.employee.name]);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, added, changed });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('bulk save failed', e);
    res.status(500).json({ error: 'could not save the table' });
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
  const { pallets, move, part_cases } = req.body || {};
  try {
    if (pallets !== undefined) {
      await pool.query(
        'UPDATE warehouse_categories SET pallets=$3::text WHERE location=$1::text AND name=$2::text',
        [loc, req.params.name, String(pallets || '').trim() || null]);
    }
    if (part_cases !== undefined) {
      await pool.query(
        'UPDATE warehouse_categories SET part_cases=$3 WHERE location=$1::text AND name=$2::text',
        [loc, req.params.name, !!part_cases]);
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

// Pull Angel's sheet in now rather than waiting for the timer. A dry run says
// what it would do and writes nothing, which is what the button offers first.
app.post('/api/place/warehouse/sheet-sync', async (req, res) => {
  if (!canWrite(req, res, 'warehouse')) return;
  if (!sheetsConfigured()) {
    return res.status(400).json({ error: 'No sheet connected. Set GOOGLE_API_KEY and WAREHOUSE_SHEET_ID in Railway.' });
  }
  try {
    const out = await syncSheet({ dryRun: !!req.body?.dry_run });
    if (!out.dry_run) await noteSheetError('');
    res.json(out);
  } catch (e) {
    console.error('sheet sync failed', e);
    await noteSheetError(e.message).catch(() => {});
    res.status(502).json({ error: e.message });
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
    const [items, routes, counts, session, vendors, order, secs, vorder] = await Promise.all([
      pool.query('SELECT * FROM items WHERE dept=$1 ORDER BY sort_order, name', [dept]),
      pool.query('SELECT * FROM routes WHERE dept=$1 ORDER BY position', [dept]),
      pool.query('SELECT * FROM counts WHERE dept=$1', [dept]),
      pool.query('SELECT * FROM session_state WHERE dept=$1', [dept]),
      pool.query('SELECT name FROM vendors WHERE dept=$1 ORDER BY name', [dept]),
      pool.query(`SELECT key, value FROM app_config WHERE key IN ($1,$2)`,
                 [`walk_${dept}_shelf`, `walk_${dept}_back`]),
      pool.query('SELECT value FROM app_config WHERE key=$1', [`sections_${dept}`]),
      pool.query('SELECT value FROM app_config WHERE key=$1', [`vendor_order_${dept}`])
    ]);
    // The order somebody actually walks each pass in. Two of them, because the
    // shelves and the back room are not arranged the same way, and walking a
    // list that disagrees with your feet is the thing that turns a count into
    // an afternoon.
    const walk = {};
    for (const r of order.rows) {
      const pass = r.key.endsWith('_back') ? 'back' : 'shelf';
      try { walk[pass] = JSON.parse(r.value); } catch { /* a corrupt order is no order */ }
    }
    res.json({
      items: items.rows,
      routes: routes.rows,
      counts: counts.rows,
      day: session.rows[0]?.day_key || null,
      vendors: vendors.rows.map(r => r.name),
      walk,
      // Loose groupings of similar products, offered in the setup screen as a way
      // to place sixteen items with one tap where a shelf happens to hold them
      // together. Only a shortcut: the walk is whatever order somebody taps.
      sections: (() => { try { return JSON.parse(secs.rows[0]?.value || 'null'); } catch { return null; } })(),
      // The order the market is walked in, stall by stall. Empty until somebody
      // sets it, and then the tickets come out in that order instead of A to Z.
      vendorOrder: (() => {
        try { const v = JSON.parse(vorder.rows[0]?.value || 'null'); return Array.isArray(v) ? v : []; }
        catch { return []; }
      })()
    });
  } catch (e) {
    console.error('bootstrap failed', e);
    res.status(500).json({ error: 'bootstrap failed' });
  }
});

// ---- Counts: upsert a single item's count (called as you tap) ----
// What to actually buy, when the pars got it wrong. Blank puts the item back on
// whatever the counts work out, so a change can always be undone.
app.put('/api/:dept/order-qty', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  if (!canWrite(req, res, dept)) return;
  const { item_name } = req.body || {};
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  const raw = req.body?.order_qty;
  const q = raw === null || raw === undefined || String(raw).trim() === '' ? null : Number(raw);
  if (q !== null && (!isFinite(q) || q < 0)) {
    return res.status(400).json({ error: 'An order has to be a number, or blank to use the worked-out one.' });
  }
  try {
    await pool.query(
      `INSERT INTO counts (dept, item_name, order_qty, counted_by, updated_at)
       VALUES ($1,$2,$3::numeric,$4,NOW())
       ON CONFLICT (dept, item_name) DO UPDATE SET order_qty=$3::numeric, updated_at=NOW()`,
      [dept, item_name, q, req.employee.name]);
    res.json({ ok: true, order_qty: q });
  } catch (e) {
    console.error('order qty save failed', e);
    res.status(500).json({ error: 'could not save that' });
  }
});

app.put('/api/:dept/count', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  if (!canWrite(req, res, dept)) return;
  const { item_name, shelf, cooler, qty } = req.body || {};
  if (!item_name) return res.status(400).json({ error: 'item_name required' });
  try {
    // order_qty is deliberately absent from both halves: counting an item again
    // must not throw away a decision the buyer already made about it.
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
  const { name, vendor, vendor2, pars, shelf_target, active, note, invdesc,
          buy_step } = req.body || {};
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
    // Null puts it back on the department's usual unit rather than pinning it.
    if (buy_step !== undefined)     { sets.push(`buy_step=$${i++}`);
      vals.push(buy_step === null || buy_step === '' ? null : Number(buy_step)); }
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

// The order a pass was actually walked in, captured by walking it. Setting two
// orders for 174 items in a settings screen is a job nobody does; doing the
// count once and pressing yes is not.
app.put('/api/:dept/walk-order', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  if (!canWrite(req, res, dept)) return;
  const pass = req.body?.pass === 'back' ? 'back' : 'shelf';
  const names = Array.isArray(req.body?.names) ? req.body.names.filter(n => typeof n === 'string') : null;
  if (!names) return res.status(400).json({ error: 'names required' });
  try {
    if (!names.length) {
      await pool.query('DELETE FROM app_config WHERE key=$1', [`walk_${dept}_${pass}`]);
      return res.json({ ok: true, cleared: true });
    }
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [`walk_${dept}_${pass}`, JSON.stringify(names)]);
    res.json({ ok: true, saved: names.length });
  } catch (e) {
    console.error('walk order save failed', e);
    res.status(500).json({ error: 'could not save that order' });
  }
});

// The order the vendors are visited in. Alphabetical is nobody's route.
app.put('/api/:dept/vendor-order', async (req, res) => {
  const dept = checkDept(req, res); if (!dept) return;
  if (!canWrite(req, res, dept)) return;
  const names = Array.isArray(req.body?.names) ? req.body.names.filter(n => typeof n === 'string') : null;
  if (!names) return res.status(400).json({ error: 'names required' });
  try {
    if (!names.length) {
      await pool.query('DELETE FROM app_config WHERE key=$1', [`vendor_order_${dept}`]);
      return res.json({ ok: true, cleared: true });
    }
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [`vendor_order_${dept}`, JSON.stringify(names)]);
    res.json({ ok: true, saved: names.length });
  } catch (e) {
    console.error('vendor order save failed', e);
    res.status(500).json({ error: 'could not save that order' });
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

// Pull the sheet on a timer so Angel's additions show up without anyone asking.
// Only the catalogue moves; counts are never touched, so a sync landing in the
// middle of somebody counting cannot undo their work.
function startSheetPolling() {
  if (!sheetsConfigured()) {
    console.log('No Google Sheet connected — set GOOGLE_API_KEY and WAREHOUSE_SHEET_ID to sync one.');
    return;
  }
  const minutes = Math.max(15, Number(process.env.WAREHOUSE_SHEET_MINUTES) || 180);
  const run = () => syncSheet()
    .then(r => {
      console.log(`Sheet sync: ${r.items} items, ${r.added} new, ${r.changed} changed`
        + (r.gone ? `, ${r.gone} in the app but no longer in the sheet (kept)` : ''));
      r.problems.forEach(p => console.warn('  sheet: ' + p));
      return noteSheetError('');
    })
    // A failed pull leaves the last catalogue in place, aged and labelled. It is
    // never a reason to take the tab down.
    .catch(e => {
      console.error('Sheet sync failed:', e.message);
      return noteSheetError(e.message).catch(() => {});
    });
  setTimeout(run, 15_000);
  setInterval(run, minutes * 60_000);
  console.log(`Sheet sync every ${minutes} minutes.`);
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Dat Moi ordering running on :${PORT}`));
    startVoriPolling();
    startSheetPolling();
    startFryWatch();
  })
  .catch(err => {
    console.error('DB init failed', err);
    process.exit(1);
  });
