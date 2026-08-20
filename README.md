# Dat Moi Ordering

Inventory counting and vendor ordering for produce, meat, and fish/seafood.

Walk the department on your phone, tap in what's on hand, and the app turns the
counts into one order ticket per vendor that you can copy and send.

## What's in it

| Department | Items | Counting mode | Order days |
|---|---|---|---|
| Produce | 169 | shelf + cooler | Mon, Thu |
| Meat | 37 | single count | Mon–Sat |
| Fish & Seafood | 139 | single count | Wed, Sun |

## Deploying to Railway

1. **Put this folder in a GitHub repo** (new repo, push these files).

2. **Create the Railway project**
   - New Project → Deploy from GitHub repo → pick the repo.

3. **Add the database and link it**
   - In the same project: New → Database → **Add PostgreSQL**.
   - Then open the **app** service → **Variables** → **New Variable**:
     name `DATABASE_URL`, value `${{Postgres.DATABASE_URL}}`
     (swap `Postgres` for whatever the database service is named).
     The leading `$` is required — `{{Postgres.DATABASE_URL}}` without it is
     passed through as plain text and never resolves.

   Railway does **not** hand one service's variables to another on its own — the
   reference above is what connects them. Without it the app exits on boot and
   tells you so in the deploy log.

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

Produce and meat ship with their PARs already filled in; fish does not. Set or
change any of them under **Settings → PARs**, or straight in the database:

```sql
UPDATE items SET pars = '{"mon":5,"tue":5,"wed":5,"thu":8,"fri":8,"sat":8}'::jsonb
WHERE dept = 'meat' AND name = 'Pork Belly';
```

**Settings → Seasonal / Active** hides anything you don't carry right now without
deleting it.

## Fish & seafood

Transcribed from the order sheet, keeping its sections as the walking route:
Fish (Fresh) 25, Shrimp 7, Shrimp (Peeled/Deveined) 7, Tiger Shrimp 5, Prawns 4,
Shrimp (Head-On/Block) 5, Shrimp (Headless/Block) 12, Shrimp (Headless/IQF) 6,
Fish (Frozen) 21, Seafood (Frozen) 47.

Three things about the transcription:

- **Yellow Croaker is the only fish bought fresh**, so it is the only one whose
  name carries the state: `Yellow Croaker (Fresh)` and `Yellow Croaker (Frozen)`,
  since an order has to say which. Barracuda, Mullet, Parrot Fish and Sierra sat
  on both of the sheet's fish lists but all arrive frozen — the same fish written
  twice — so each is one line under the frozen list now, carrying every supplier
  either line named.
- **Items ruled out on the sheet are kept but switched off** — 15 of them. They
  stay off orders and out of the count, and **Settings → Seasonal / Active**
  brings one back rather than retyping it.
- **The second vendor column is kept as an alternate**, shown while counting as
  `or NAUTILUS`. Orders are grouped by the first vendor only, so the alternate
  never appears in the message a vendor receives.

PARs are all at 0 until the real ones are set under **Settings → PARs**.

## Adding an item

**Settings → Add an Item** adds one to the department you're in: shelf name, the
vendor's name for it if it differs, and a vendor. It starts with every PAR at 0,
so it stays off orders until you set one under **PARs**.

`seed_items.json` seeds a department that has **no rows at all**. A department
holding items is never touched by a deploy, so live PARs, counts and edits are
safe — but a department that is empty will fill from the seed on the next boot.

## Adding or changing items in SQL

`mode` is either `single` (one count vs a PAR — meat and fish) or `shelf_cooler`
(shelf + cooler, like produce).

```sql
INSERT INTO items (dept, name, vendor, mode, pars, sort_order)
VALUES ('fish', 'Whole Tilapia', 'SEALAND', 'single',
        '{"mon":5,"tue":5,"wed":5,"thu":8,"fri":8,"sat":8}'::jsonb, 0);
```

Vendor names are stored uppercase. A vendor typed on an item shows up in
**Settings → Vendors** on its own; items left without one collect on a single
"UNASSIGNED VENDOR" ticket until you assign them.

Changing `seed_items.json` only affects a **fresh** database — the seed runs once,
when the items table is empty, so redeploys never overwrite live data. To reload a
department that's already deployed, clear it first:

```sql
DELETE FROM counts  WHERE dept = 'fish';
DELETE FROM routes  WHERE dept = 'fish';
DELETE FROM vendors WHERE dept = 'fish';
DELETE FROM items   WHERE dept = 'fish';
```

## What gets copied

**Copy text for <vendor>** puts this on the clipboard, ready to paste into a
text or email:

```
Dat Moi Order - 8/20

Pork Belly: 3
Oxtail: 1 - order as needed
```

One ticket per vendor, so the vendor's own name is left out of the message.
An item only carries a trailing note if one was set on it.

**Items go out under the name the vendor uses for them.** An item has two names:
the one it's sold under in the store, and the one the vendor calls it — `BANANA
BLOSSOM` on the shelf is `BANANA FLOWER` on the order. The order uses the vendor's
name; the counting screen and the order ticket both show the shelf name so you can
still recognise what you counted. Edit them under **Settings → Order Names**, where
an empty box means "send the shelf name". They live in the `invdesc` column.

Quantities are shown and sent as plain numbers. Case sizes are still stored on
the item and used nowhere in the display — re-add them to the ticket line in
`showSummary` and to `buildText` if a vendor ever needs them spelled out.

## How ordering is calculated

- **single**: `order = par(today) − counted`, floored at 0.
- **shelf_cooler**: `order = (shelf_target − shelf) + (cooler_par(today) − cooler)`,
  each piece floored at 0.

Anything that comes out at 0 stays off the ticket.

## If the deploy crashes

The app prints the reason and exits rather than looping silently. Check the
**Deploy** logs:

- **`No database connection string found`** — the database isn't linked. Do step 3
  above. `DATABASE_PRIVATE_URL`, `POSTGRES_URL` and `POSTGRESQL_URL` are accepted
  too, so either name from Railway's reference picker works.
- **`Postgres refused the ... connection`** — harmless. Railway's private network
  (`postgres.railway.internal`) runs without TLS while its public proxy requires
  it, so the app tries one, falls back to the other, and carries on. Force it
  either way with a `DATABASE_SSL` variable set to `on` or `off`.
- **`is missing the leading $`** — the value reads `{{Postgres.DATABASE_URL}}`.
  Railway only expands `${{...}}`, so add the `$` at the front.
- **`still holds an unresolved Railway reference`** — the name inside `${{...}}`
  doesn't match a service in the project. Read the database service's exact name
  off its header, or use **Variables → Add a Reference** and pick it from the list.
- **`is not a Postgres connection string`** — the variable holds something other
  than a `postgresql://` URL. The log prints the value with the password masked.
- **`password authentication failed`** — the `DATABASE_URL` value is stale. Re-point
  it at `${{Postgres.DATABASE_URL}}` rather than pasting a literal URL, so it keeps
  working when Railway rotates the credentials.

A successful boot logs three lines:

```
Connected to Postgres at postgres.railway.internal:5432.
Empty items table detected — seeding initial data.
Seed complete.
```

On later boots the middle line reads `Items table already has N rows — skipping seed.`

## Local development

```bash
npm install
DATABASE_URL="postgres://user:pass@localhost:5432/datmoi" npm start
```

## Backups

Railway's Postgres plugin supports snapshots from its dashboard. Worth turning on
once you're relying on this daily.
