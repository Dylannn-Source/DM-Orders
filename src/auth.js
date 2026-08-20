// PIN hashing, session cookies and the gate in front of the API.
//
// PINs are short by design — staff type them on a phone with wet hands — so the
// safety comes from throttling guesses rather than from length. A 6-digit PIN is
// a million combinations, which is only meaningful while an attacker cannot try
// them quickly. Hence the lockout below, which matters more than the PIN format.
import crypto from 'crypto';
import { pool } from './db.js';

const COOKIE = 'dm_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// ---- PIN hashing -----------------------------------------------------------
// scrypt, from Node's own crypto, so there is no dependency to keep current.
// One-way: a leaked backup or a look at the database yields no working PINs.
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length,
      { N: 16384, r: 8, p: 1 });
  } catch { return false; }
  // Constant time, so a wrong PIN cannot be narrowed down by how long it took.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function isValidPin(pin, { allowShort = false } = {}) {
  const s = String(pin ?? '');
  if (!/^\d+$/.test(s)) return 'A PIN can only contain digits.';
  const min = allowShort ? 4 : 6;
  if (s.length < min || s.length > 6) {
    return allowShort ? 'A PIN must be 4 to 6 digits.' : 'Choose a 6-digit PIN.';
  }
  if (!allowShort) {
    if (/^(\d)\1+$/.test(s)) return 'That PIN is all one digit — pick another.';
    if ('0123456789'.includes(s) || '9876543210'.includes(s)) {
      return 'That PIN runs in sequence — pick another.';
    }
  }
  return null;
}

// ---- session secret --------------------------------------------------------
// Kept in the database rather than generated per boot, so a redeploy does not
// sign everyone out mid-count. SESSION_SECRET overrides it when set.
let cachedSecret = null;
export async function sessionSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.SESSION_SECRET) return (cachedSecret = process.env.SESSION_SECRET);
  const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='session_secret'`);
  if (rows[0]) return (cachedSecret = rows[0].value);
  const made = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ('session_secret', $1)
     ON CONFLICT (key) DO NOTHING`, [made]);
  const { rows: again } = await pool.query(`SELECT value FROM app_config WHERE key='session_secret'`);
  return (cachedSecret = again[0].value);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

export async function issueSession(res, employee) {
  const secret = await sessionSecret();
  const token = sign({ id: employee.id, at: Date.now() }, secret);
  const parts = [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  ];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function currentEmployee(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const claims = unsign(token, await sessionSecret());
  if (!claims?.id) return null;
  if (Date.now() - Number(claims.at || 0) > SESSION_DAYS * 24 * 60 * 60 * 1000) return null;
  const { rows } = await pool.query(
    `SELECT id, name, role, active, must_change_pin FROM employees WHERE id=$1`, [claims.id]);
  const e = rows[0];
  return e && e.active ? e : null;
}

// ---- lockout ---------------------------------------------------------------
// Locking an account on failures alone lets anyone lock the whole team out by
// typing rubbish, so the lock lifts by itself after a short wait. A manager can
// clear it immediately, and a correct PIN resets the counter.
export function lockState(row) {
  if (!row?.locked_until) return { locked: false };
  const until = new Date(row.locked_until).getTime();
  if (until <= Date.now()) return { locked: false };
  return { locked: true, minutes: Math.max(1, Math.ceil((until - Date.now()) / 60000)) };
}

export async function noteFailure(id) {
  const { rows } = await pool.query(
    `UPDATE employees
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE id = $1
      RETURNING failed_attempts, locked_until`,
    [id, MAX_FAILURES, String(LOCK_MINUTES)]);
  return rows[0];
}

export async function noteSuccess(id) {
  await pool.query(
    `UPDATE employees SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE id=$1`,
    [id]);
}

// A second line of defence that does not depend on knowing which account is
// being guessed: slow down an address making many attempts, whoever it targets.
const attemptsByIp = new Map();
export function ipThrottled(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const hits = (attemptsByIp.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now);
  attemptsByIp.set(ip, hits);
  if (attemptsByIp.size > 5000) attemptsByIp.clear();   // never grows without bound
  return hits.length > 20;
}

export { MAX_FAILURES, LOCK_MINUTES };
