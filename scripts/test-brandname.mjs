// Where the brand lands in a product name.    node scripts/test-brandname.mjs
//
// These are real names out of the catalogue, not invented ones. The case that
// matters most is "16 Bean Soup Mix": a leading number that is part of the name
// rather than a pack size, which is the one thing a naive rule gets wrong.
import { withBrand, proposal } from '../src/brandname.js';

let failed = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      -> ${got}`);
  if (!ok) console.log(`      want ${want}`);
};

console.log('\nThe size keeps the front of the name:\n');
for (const [name, want] of [
  ['10lbs Golden Canilla Parboiled Rice', '10lbs Goya Golden Canilla Parboiled Rice'],
  ['5lbs Golden Canilla Parboiled Rice',  '5lbs Goya Golden Canilla Parboiled Rice'],
  ['12x Extra Fine Corn Meal',            '12x Goya Extra Fine Corn Meal'],
  ['24 x 15oz Butter Bean',               '24 x 15oz Goya Butter Bean'],
  ['24x17oz Coconut Water',               '24x17oz Goya Coconut Water'],
  ['24Pk Refresco',                       '24Pk Goya Refresco'],
  ['30x Case Mi Goreng',                  '30x Case Goya Mi Goreng'],
]) eq(name, withBrand(name, 'Goya'), want);

console.log('\nEverything else just takes the brand in front:\n');
for (const [name, want] of [
  // Sixteen kinds of bean, not a pack of sixteen.
  ['16 Bean Soup Mix',   'Goya 16 Bean Soup Mix'],
  // A size at the end is not a lead.
  ['Beef Patties 9oz',   'Goya Beef Patties 9oz'],
  ['Adobo With Cumin',   'Goya Adobo With Cumin'],
  ['Amaranth',           'Goya Amaranth'],
  ['Annatto Seeds',      'Goya Annatto Seeds'],
  // Nothing but a size is not a name to insert into.
  ['12x',                'Goya 12x'],
]) eq(name, withBrand(name, 'Goya'), want);

console.log('\n--plain puts it in front regardless:\n');
eq('24 x 15oz Butter Bean',
   withBrand('24 x 15oz Butter Bean', 'Goya', { sizeAware: false }),
   'Goya 24 x 15oz Butter Bean');

console.log('\nWhat gets left alone:\n');
for (const [name, brand, why] of [
  ['Goya Corn Oil', 'Goya', 'already starts with the brand'],
  ['12x Goya Plantain Chips', 'Goya', 'brand already in the name'],
  ['Indomie Mi Goreng', 'Indomie ', 'already starts with the brand'],
  ['', 'Goya', 'no name'],
  ['X'.repeat(252), 'Goya', 'would pass 255 characters'],
]) {
  const p = proposal({ name }, brand);
  const ok = p.action === 'skip' && p.why === why;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${(name || '(blank)').slice(0, 40)} — ${p.why || p.action}`);
}

// Case and spacing wobble in the catalogue: "Badia" and "BADIA" are two brands
// as far as the data is concerned, and a trailing space makes a third.
console.log('\nSpelling wobble:\n');
eq('badia / Oregano', withBrand('Oregano', 'badia'), 'badia Oregano');
eq('"Goya " trailing space', withBrand('Amaranth', 'Goya '), 'Goya Amaranth');

console.log(failed ? `\n${failed} FAILED\n` : '\nAll passed.\n');
process.exit(failed ? 1 : 0);
