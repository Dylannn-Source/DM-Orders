// Puts the brand at the front of a product's name, for the places that show
// the name and nothing else -- the receipt, the shelf tag, Instacart.
//
// Run it from the Railway console, one brand at a time:
//
//   node scripts/brand-prefix.mjs --brand "Goya"            # says what it would do
//   node scripts/brand-prefix.mjs --brand "Goya" --apply    # does it
//   node scripts/brand-prefix.mjs --reverts                 # what can be undone
//   node scripts/brand-prefix.mjs --revert <key|file>       # puts it back
//
// Without --apply nothing is written. Every run, dry or not, drops a CSV you
// can open and read. A run that writes also saves the original names, to a
// file and to the database -- that snapshot is the only way back.
//
// Writing uses VORI_WRITE_KEY when one is set, and otherwise VORI_API_KEY,
// which carries banner admin. That is deliberate: the store has one key and it
// can write. What stands between a typo and five thousand renamed products is
// not the key, then, but --apply and the snapshot, so neither is optional.
import fs from 'node:fs';
import path from 'node:path';
import { initDb, pool } from '../src/db.js';

const argv = process.argv.slice(2);
const flag = n => {
  const i = argv.indexOf(n);
  return i === -1 ? null : (argv[i + 1] ?? '');
};
const has = n => argv.includes(n);

const BASE = process.env.VORI_API_BASE || 'https://api.vori.com/v1';
const STORE = process.env.VORI_STORE_ID || '5084';
const READ_KEY = process.env.VORI_API_KEY || process.env.VORI_WRITE_KEY;
const WRITE_KEY = process.env.VORI_WRITE_KEY || process.env.VORI_API_KEY;
const OUT = path.resolve('out');
const APPLY = has('--apply');
// Vori allows 20 a second. A rename is not urgent and a catalogue is not worth
// rushing, so this sits well under it.
const GAP_MS = Number(process.env.BRAND_GAP_MS || 150);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, url, body, key) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      await sleep(wait + Math.random() * 500);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      if (res.status >= 500 && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error('gave up after repeated rate limiting');
}

async function allProducts() {
  const out = [];
  let cursor = null;
  for (;;) {
    const p = new URLSearchParams({ limit: '100', active: 'true', store_id: STORE });
    if (cursor) p.set('starting_after', cursor);
    const body = await call('GET', `${BASE}/store-products?${p}`, null, READ_KEY);
    const page = body?.data || [];
    out.push(...page);
    process.stdout.write(`\r  read ${out.length} products…`);
    if (!body?.has_more || !page.length) break;
    cursor = page[page.length - 1].id;
  }
  process.stdout.write('\n');
  return out;
}

// Trim and fold, because the catalogue holds "Badia" and "BADIA" as different
// brands, and "Indomie" with a trailing space as a third.
const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
const fold = s => norm(s).toLowerCase();

function proposal(prod, brand) {
  const name = norm(prod.name);
  const b = norm(brand);
  if (!name) return { action: 'skip', why: 'no name' };
  // Already says it -- prefixing would give "Indomie Indomie Mi Goreng".
  if (fold(name).startsWith(fold(b))) return { action: 'skip', why: 'already starts with the brand' };
  if (fold(name).includes(fold(b))) return { action: 'skip', why: 'brand already in the name' };
  const next = `${b} ${name}`;
  if (next.length > 255) return { action: 'skip', why: 'would pass 255 characters' };
  return { action: 'rename', next };
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Railway's filesystem does not survive a redeploy, so the file on its own is
// not a way back -- it is gone the next time the app ships. The snapshot goes
// into Postgres as well, which does last, and --revert takes either.
async function saveSnapshot(key, snap) {
  await initDb();
  await pool.query(
    `INSERT INTO app_config (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(snap)]);
}

async function loadSnapshot(ref) {
  if (fs.existsSync(ref)) return JSON.parse(fs.readFileSync(ref, 'utf8'));
  await initDb();
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [ref]);
  if (!rows[0]) throw new Error(`No snapshot on disk or in the database called "${ref}"`);
  return JSON.parse(rows[0].value);
}

async function listSnapshots() {
  await initDb();
  const { rows } = await pool.query(
    `SELECT key, value FROM app_config WHERE key LIKE 'brand_rename:%' ORDER BY key DESC`);
  if (!rows.length) { console.log('No renames have been run yet.'); return; }
  console.log('\nSnapshots you can revert:\n');
  for (const r of rows) {
    let n = '?', at = '';
    try { const v = JSON.parse(r.value); n = v.items.length; at = v.at; } catch {}
    console.log(`  ${r.key}   ${n} products   ${at}`);
  }
  console.log('\nnode scripts/brand-prefix.mjs --revert <key>');
}

async function revert(file) {
  if (!WRITE_KEY) throw new Error('No Vori key set (VORI_API_KEY or VORI_WRITE_KEY)');
  const snap = await loadSnapshot(file);
  console.log(`Putting ${snap.items.length} names back as they were.`);
  let done = 0;
  for (const it of snap.items) {
    await call('PATCH', `${BASE}/store-products/${it.id}`,
      { data: { name: it.was } }, WRITE_KEY);
    done++;
    process.stdout.write(`\r  ${done}/${snap.items.length}`);
    await sleep(GAP_MS);
  }
  console.log(`\nDone. ${done} names restored.`);
}

if (has('--reverts')) { await listSnapshots(); process.exit(0); }
const revertFile = flag('--revert');
if (revertFile) { await revert(revertFile); process.exit(0); }

const BRAND = flag('--brand');
if (!BRAND && !has('--list')) {
  console.error('Which brand? e.g. --brand "Goya"');
  console.error('Run with --list to see the brands and how many each would change.');
  process.exit(1);
}
if (!READ_KEY) { console.error('VORI_API_KEY is not set.'); process.exit(1); }

const products = await allProducts();

if (has('--list')) {
  const tally = new Map();
  for (const p of products) {
    const b = norm(p.brand);
    if (!b) continue;
    const key = fold(b);
    if (!tally.has(key)) tally.set(key, { brand: b, total: 0, rename: 0 });
    const t = tally.get(key);
    t.total++;
    if (proposal(p, b).action === 'rename') t.rename++;
  }
  const rows = [...tally.values()].sort((a, b) => b.rename - a.rename);
  console.log('\nbrand                            products   would change');
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.brand.padEnd(30)} ${String(r.total).padStart(8)} ${String(r.rename).padStart(14)}`);
  }
  const noBrand = products.filter(p => !norm(p.brand)).length;
  console.log(`\n${products.length} active products, ${noBrand} with no brand, ${rows.length} brands.`);
  process.exit(0);
}

const mine = products.filter(p => fold(p.brand) === fold(BRAND));
if (!mine.length) {
  console.error(`No active products carry the brand "${BRAND}".`);
  console.error('Spelling and spacing have to match -- try --list.');
  process.exit(1);
}

const plan = mine.map(p => ({ p, ...proposal(p, BRAND) }));
const renames = plan.filter(x => x.action === 'rename');

fs.mkdirSync(OUT, { recursive: true });
const slug = fold(BRAND).replace(/[^a-z0-9]+/g, '-');
const csvPath = path.join(OUT, `brand-${slug}.csv`);
const snapPath = path.join(OUT, `${slug}.json`);

fs.writeFileSync(csvPath, [
  ['id', 'barcode', 'action', 'why', 'name now', 'name after'].join(','),
  ...plan.map(x => [x.p.id, x.p.barcode, x.action, x.why || '',
                    norm(x.p.name), x.next || ''].map(csvCell).join(','))
].join('\n') + '\n');

console.log(`\n${BRAND}: ${mine.length} products, ${renames.length} would change.`);
for (const x of renames.slice(0, 10)) console.log(`  ${norm(x.p.name)}  ->  ${x.next}`);
if (renames.length > 10) console.log(`  …and ${renames.length - 10} more`);
const skipped = plan.filter(x => x.action === 'skip');
if (skipped.length) {
  const why = {};
  for (const x of skipped) why[x.why] = (why[x.why] || 0) + 1;
  console.log('\nleft alone:');
  for (const [k, v] of Object.entries(why)) console.log(`  ${v}  ${k}`);
}
console.log(`\nThe full list is in ${csvPath}`);

if (!APPLY) {
  console.log('\nNothing was changed. Read the CSV, then run again with --apply.');
  process.exit(0);
}
if (!WRITE_KEY) {
  console.error('\nNo Vori key set — expected VORI_API_KEY or VORI_WRITE_KEY.');
  process.exit(1);
}
if (!renames.length) { console.log('\nNothing to do.'); process.exit(0); }

// The snapshot is written BEFORE the first change, so a run that dies halfway
// can still be undone in full.
const snapshot = {
  brand: BRAND, store: STORE, at: new Date().toISOString(),
  items: renames.map(x => ({ id: x.p.id, was: norm(x.p.name), to: x.next }))
};
fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
const dbKey = `brand_rename:${slug}:${snapshot.at}`;
try {
  await saveSnapshot(dbKey, snapshot);
  console.log(`\nOriginal names saved to ${snapPath}`);
  console.log(`and to the database as  ${dbKey}`);
} catch (e) {
  // Without a durable copy there is no undo once the container restarts. That
  // is a reason to stop, not a warning to scroll past.
  console.error(`\nCould not save the snapshot to the database: ${e.message}`);
  console.error('Refusing to rename anything without a way back.');
  process.exit(1);
}

let done = 0, failed = 0;
for (const x of renames) {
  try {
    await call('PATCH', `${BASE}/store-products/${x.p.id}`,
      { data: { name: x.next } }, WRITE_KEY);
    done++;
  } catch (e) {
    failed++;
    console.error(`\n  ${x.p.id} ${norm(x.p.name)}: ${e.message}`);
  }
  process.stdout.write(`\r  ${done + failed}/${renames.length}`);
  await sleep(GAP_MS);
}
console.log(`\n\n${done} renamed${failed ? `, ${failed} failed` : ''}.`);
console.log(`To undo:  node scripts/brand-prefix.mjs --revert ${dbKey}`);
await pool.end().catch(() => {});
