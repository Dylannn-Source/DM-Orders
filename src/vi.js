// The Vietnamese names for the offsite warehouse.
//
// These are shipped with the app rather than typed into it, because there are
// two hundred of them and nobody was going to. Applied on boot so the app
// carries its own translations: a deploy is enough, and nobody has to be told
// to run a script against the production database.
//
// It only ever fills a blank. A name typed at the pallet is somebody's
// correction and outranks anything shipped here, and a name deliberately
// cleared stays cleared -- which is why the bulk fill runs once and then marks
// itself done rather than reasserting itself on every restart.
import { readFileSync } from 'node:fs';

const LOC = 'warehouse';
const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));

let cache = null;
function tables() {
  if (cache) return cache;
  const vi = read('warehouse_vi.json');
  const seed = read('seed_warehouse.json');
  // Spelling in the sheet is not consistent -- "Pineapple Gel In Syrup" and
  // "Pineapple Gel in Syrup" are the same product -- so the lookup ignores case
  // and runs of spaces.
  const key = d => String(d || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byDesc = {};
  for (const [k, v] of Object.entries(vi.by_desc)) byDesc[key(k)] = v;
  const descOf = {};
  for (const it of seed.items) if (it.desc) descOf[it.name] = it.desc;
  return (cache = { byDesc, descOf, cats: vi.categories, key });
}

// The seed knows each item's description outright. Anything that arrived from
// the sheet instead has to have it worked back out of the composed name, which
// is brand + description + size with single spaces between.
function deriveDesc(row) {
  let s = row.item_name || '';
  if (row.brand && s.startsWith(row.brand + ' ')) s = s.slice(row.brand.length + 1);
  if (row.size && s.endsWith(' ' + row.size)) s = s.slice(0, -(row.size.length + 1));
  return s.trim();
}

export function viFor(row) {
  const { byDesc, descOf, key } = tables();
  return byDesc[key(descOf[row.item_name])] || byDesc[key(deriveDesc(row))] || null;
}
export function viForCategory(name) {
  return tables().cats[name] || null;
}

// Fills every blank it can and reports what it did. Safe to call again: a row
// that already has a name is not looked at.
export async function fillViNames(db) {
  const { rows } = await db.query(
    `SELECT item_name, brand, size FROM warehouse_stock
      WHERE location=$1 AND name_vi IS NULL`, [LOC]);
  let items = 0;
  for (const r of rows) {
    const v = viFor(r);
    if (!v) continue;
    await db.query(
      `UPDATE warehouse_stock SET name_vi=$3
        WHERE location=$1 AND item_name=$2 AND name_vi IS NULL`, [LOC, r.item_name, v]);
    items++;
  }
  const { rows: cats } = await db.query(
    `SELECT name FROM warehouse_categories WHERE location=$1 AND name_vi IS NULL`, [LOC]);
  let pallets = 0;
  for (const c of cats) {
    const v = viForCategory(c.name);
    if (!v) continue;
    await db.query(
      `UPDATE warehouse_categories SET name_vi=$3
        WHERE location=$1 AND name=$2 AND name_vi IS NULL`, [LOC, c.name, v]);
    pallets++;
  }
  return { items, pallets, looked: rows.length, noMatch: rows.length - items };
}
