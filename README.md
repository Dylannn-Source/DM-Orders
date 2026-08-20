# Dat Moi Ordering

Inventory counting and vendor ordering for produce, meat, and fish/seafood.

Walk the department on your phone, tap in what's on hand, and the app turns the
counts into one order ticket per vendor that you can copy and send.

## What's in it

| Department | Items | Counting mode | Order days |
|---|---|---|---|
| Produce | 169 | shelf + cooler | Mon, Thu |
| Meat | 37 | single count | Mon–Sat |
| Fish & Seafood | 151 | single count | Mon–Sat |

## Deploying to Railway

1. **Put this folder in a GitHub repo** (new repo, push these files).

2. **Create the Railway project**
   - New Project → Deploy from GitHub repo → pick the repo.

3. **Add the database**
   - In the same project: New → Database → **Add PostgreSQL**.
   - Railway automatically provides `DATABASE_URL` to the app. Nothing to configure.

4. **Generate a public URL**
   - Service → Settings → Networking → **Generate Domain**.
   - That URL is permanent. Add it to your phone's Home Screen and it keeps working
     through every future deploy.

On first boot the app creates its tables and loads the starting items. On every
later boot it sees existing data and leaves it alone.

## Updating later

Push to GitHub. Railway redeploys. **Your data is untouched** — it lives in
Postgres, not in the code. The URL doesn't change, so Home Screen icons and
anyone's bookmarks keep working.

## First run: set your PARs

A PAR is how much of an item you want on hand for a given day. The order is
computed against it, so **until a PAR is set, an item never gets ordered.**

Produce and meat ship with their PARs already filled in. **Fish/seafood ships
with every PAR at 0** — the item list came out of the POS, but the PARs are the
buyer's call and aren't recorded there. Set them under **Settings → PARs**, or
straight in the database:

```sql
UPDATE items SET pars = '{"mon":5,"tue":5,"wed":5,"thu":8,"fri":8,"sat":8}'::jsonb
WHERE dept = 'fish' AND name = 'Fresh Tilapia';
```

You don't have to do all 151 at once. Set PARs for what you actually reorder and
the rest sit quietly at 0. **Settings → Seasonal / Active** hides what you don't
carry right now.

## Where the fish/seafood list came from

It was pulled from the Dat Moi POS catalog (store 5084) and merged from four
POS departments into one ordering department, grouped into a walking route:

| Route section | Items | POS source |
|---|---|---|
| Fresh Fish Case | 72 | Fish |
| Shrimp & Prawn | 33 | Shrimp |
| Shellfish & Crab | 15 | Seafood |
| Oyster Bar | 5 | Oysters + Seafood |
| Squid & Octopus | 12 | Seafood + Fish |
| Salt, Smoked & Dried | 10 | Fish + Seafood |
| Frozen & Prepared | 4 | Seafood |

Reorder or regroup any of it under **Settings → My Routine** so it matches the
way you actually walk the department.

Three judgment calls worth knowing about:

- **56 of the 151 items came with a vendor**, taken from the POS latest-cost
  record (Nautilus, Sealand, Sealand Seafood, H&N, H&T, Island Boy, La Ruche,
  Pacific American Fish Co, Pafco, Rivera, Anjo's Imports, Costco, Sam's Club).
  The other 95 show as *vendor unassigned* and land on an "UNASSIGNED VENDOR"
  ticket until you set them under **Settings → Vendors**.
- **Two POS items were left out** as miscategorized: *Smoked Ham Hock* (filed
  under Seafood, but it's meat) and *Fine Shrimp Sauce* (filed under Shrimp, but
  it's a shelf condiment).
- **Case sizes were only carried over where the POS figure was unambiguously a
  pound count** for a fish case. Shrimp blocks were left blank because the source
  mixes `EACH` and `LB` units, and a wrong case size on a vendor order costs real
  money. Items without a case size just print a plain quantity on the ticket.

## Adding or changing items

`mode` is either `single` (one count vs a PAR — meat and fish) or `shelf_cooler`
(shelf + cooler, like produce).

```sql
INSERT INTO items (dept, name, vendor, mode, pars, sort_order)
VALUES ('fish', 'Whole Tilapia', 'SEALAND', 'single',
        '{"mon":5,"tue":5,"wed":5,"thu":8,"fri":8,"sat":8}'::jsonb, 0);
```

## How ordering is calculated

- **single**: `order = par(today) − counted`, floored at 0.
- **shelf_cooler**: `order = (shelf_target − shelf) + (cooler_par(today) − cooler)`,
  each piece floored at 0.

Anything that comes out at 0 stays off the ticket.

## Local development

```bash
npm install
DATABASE_URL="postgres://user:pass@localhost:5432/datmoi" npm start
```

## Backups

Railway's Postgres plugin supports snapshots from its dashboard. Worth turning on
once you're relying on this daily.
