# Dat Moi Ordering

Inventory counting and vendor ordering for produce, meat, and fish/seafood.

Walk the department on your phone, tap in what's on hand, and the app turns the
counts into one order ticket per vendor that you can copy and send.

## What's in it

| Department | Items | Counting mode | Order days |
|---|---|---|---|
| Produce | 169 | shelf + cooler | Mon, Thu |
| Meat | 37 | single count | Mon–Sat |
| Fish & Seafood | *empty — awaiting item list* | single count | Mon–Sat |

## Deploying to Railway

1. **Put this folder in a GitHub repo** (new repo, push these files).

2. **Create the Railway project**
   - New Project → Deploy from GitHub repo → pick the repo.

3. **Add the database and link it**
   - In the same project: New → Database → **Add PostgreSQL**.
   - Then open the **app** service → **Variables** → **New Variable**:
     name `DATABASE_URL`, value `${{Postgres.DATABASE_URL}}`
     (swap `Postgres` for whatever the database service is named).

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

Produce and meat ship with their PARs already filled in. Set or change any of
them under **Settings → PARs**, or straight in the database:

```sql
UPDATE items SET pars = '{"mon":5,"tue":5,"wed":5,"thu":8,"fri":8,"sat":8}'::jsonb
WHERE dept = 'meat' AND name = 'Pork Belly';
```

**Settings → Seasonal / Active** hides anything you don't carry right now without
deleting it.

## Fish & seafood

The department is wired up end to end — tab, six-day toggle, PARs, vendors,
routes, order tickets — but **it has no items in it yet**. It's waiting on the
real buy list: what Dat Moi actually orders and from which vendor.

To load it, add rows to the `"fish"` array in `seed_items.json` before a first
deploy, or insert them into a running database (see below). Optionally group them
into a walking route in `seed_routes.json` so counting follows the way you move
through the department.

## Adding or changing items

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
