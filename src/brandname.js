// Where the brand goes in a product name.
//
// Instacart and the receipt show the name and nothing else, so a brand kept in
// its own field is invisible exactly where it matters. Folding it into the name
// fixes that -- but not by always sticking it on the front.
//
// A lot of these names lead with the pack size: "10lbs Golden Canilla",
// "24 x 15oz Butter Bean", "12x Extra Fine Corn Meal". "Goya 24 x 15oz Butter
// Bean" reads badly, so the size keeps the front of the name and the brand goes
// in behind it.
//
// A bare number is NOT a size. "16 Bean Soup Mix" is sixteen kinds of bean, not
// a pack of sixteen, so a leading number only counts as a size when a unit
// follows it or it is joined to an x. That one distinction is the whole reason
// this is a regex rather than a split on the first space.

// Trim and fold, because the catalogue holds "Badia" and "BADIA" as different
// brands, and "Indomie" with a trailing space as a third.
export const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
export const fold = s => norm(s).toLowerCase();

const UNIT = 'x|pk|ct|pc|pack|lbs?|oz|g|kg|ml|l|gal|qt|pt';
const SIZE_LEAD = new RegExp(
  `^((?:\\d+(?:\\.\\d+)?\\s*(?:${UNIT})\\b\\.?|\\d+(?:\\.\\d+)?\\s*x)\\s*)+(?:(?:case|pack)\\s+)?`, 'i');

export function withBrand(name, brand, { sizeAware = true } = {}) {
  const n = norm(name);
  const b = norm(brand);
  if (!sizeAware) return `${b} ${n}`;
  const m = n.match(SIZE_LEAD);
  const lead = m ? m[0].trim() : '';
  if (!lead) return `${b} ${n}`;
  const rest = n.slice(m[0].length).trim();
  // Nothing but a size is not a name to insert into.
  if (!rest) return `${b} ${n}`;
  return `${lead} ${b} ${rest}`;
}

// What should happen to one product, and why. Kept here with the rule so the
// reasons can be tested without reaching for a database or the network.
export function proposal(prod, brand, opts) {
  const name = norm(prod.name);
  const b = norm(brand);
  if (!name) return { action: 'skip', why: 'no name' };
  // Already says it -- prefixing would give "Indomie Indomie Mi Goreng".
  if (fold(name).startsWith(fold(b))) return { action: 'skip', why: 'already starts with the brand' };
  if (fold(name).includes(fold(b))) return { action: 'skip', why: 'brand already in the name' };
  const next = withBrand(name, b, opts);
  if (next.length > 255) return { action: 'skip', why: 'would pass 255 characters' };
  return { action: 'rename', next };
}
