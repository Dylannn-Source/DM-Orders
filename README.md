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

## Signing in

Everything under `/api` refuses without a session, so the sign-in screen is all a
stranger with the URL can reach.

**First run** asks for a name and a 6-digit PIN and makes that person a manager.
It only works while no employee exists, which is what stops it being a way in
later.

**Adding someone** — Settings → Employees, managers only. Give them a temporary
PIN; the last four of their phone number is the easy choice, since they already
know it and nothing has to be passed around. They must choose their own 6-digit
PIN the first time they sign in, so the temporary one stops working immediately.

**Forgotten PINs** — hit Reset next to their name and give them a new temporary
one. You cannot read a PIN back: they are stored hashed, one way, so a copy of
the database or a backup file yields no working PINs. Reset also clears a
lockout, since to whoever is standing there those are the same problem.

**Wrong PINs** lock an account for 15 minutes after 5 tries. The lock lifts by
itself, so nobody can shut the team out by typing rubbish, and a manager can
clear it at once. Short PINs are only safe because guessing is throttled — that
matters more than the number of digits.

**Locked out of everything**, with no manager able to sign in? From the Railway
console, where `DATABASE_URL` is already set:

```bash
node scripts/reset-pin.mjs                # who exists
node scripts/reset-pin.mjs "Dylan" 4821   # give them a temporary PIN
```

If no active manager is left it promotes that person, so the app cannot be shut
out of permanently.

**Who can change what.** Everyone signed in can *look* at everything — every
department, every PAR, the warehouse, the movement log, past orders. Changing
something needs that area granted, per person, under **Settings → Employees**:
produce, meat, fish, warehouse, coldstorage, ticked individually. A manager has all four by
role and needs no ticks.

Granting an area covers everything that writes to it: counting, PARs, vendors,
order names, routes, adding items, placing the order, and — for the warehouse —
moving stock, pallets and Vori links. Adding and resetting employees, running a
Vori sync, and downloading the backup stay manager-only.

Where someone cannot edit, the controls are not shown: no steppers, no Reset, no
edit screens in Settings, no warehouse Update, and the header says **view only**.
That is a courtesy — every one of those routes checks the grant itself, so hiding
a button is not what enforces anything.

**Who did what** is recorded on each count and each order — `counts.counted_by`
and `order_history.placed_by`.

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

## Stock held away from the shop floor

Two places, one screen: the **offsite warehouse**, divided into pallets, and the
**cold storage containers at MonkishZ**. They share tables keyed by location, so
both get staleness, cases-and-loose, movements, Vori links and permissions from
one implementation rather than two that drift apart. The same item name can sit
in both without collision.

Cold storage opens on a **plan of the containers** rather than a list, because the
first question there is which box something is in and you cannot see inside one
from the door. Each container shows what it holds and turns red when something
inside has gone a month unchecked. Tapping one drops into its contents; searching
cuts across all of them.

**+ add** on a container opens the form already pointed at it, so what you add
goes where you were standing. Set the containers up first under **Manage
containers**, then fill them.

**Inside a container are eight pallet spots** — the number that fits, not a
default. They exist from the moment the container is created, so an empty one is
a place to put something rather than something to make first, and there is no way
to add a ninth from anywhere in the app.

They are drawn as you look in from the doors: the back of the container at the top
of the screen, spots 1 and 2 nearest you at the bottom, with both ends labelled.

**Tapping a pallet gives three rows** — top, middle, bottom — each a quantity and
a product, filled in directly:

```
            1
   TOP     15   cow feet
   MIDDLE  20   goat
   BOTTOM  20   tilapia
```

A product typed in that is not on the list yet is created; clearing a row takes
it off the pallet but leaves it in the container, in the unplaced pile. Each spot
on the grid shows its three lines, so the container reads at a glance without
opening anything.

Every row elsewhere carries where it is — `Container 2 · 1 · middle` — so
searching for something tells you exactly where to walk.

Deleting a pallet leaves its items in the container, off any pallet, rather than
taking them with it.

## The offsite warehouse

The fourth tab is not a counting screen. The other three ask what is on the
shelf right now, answered by whoever is standing in front of it. Nobody is
standing in front of the warehouse — a few people go occasionally — so a
quantity there is only as good as its age.

Every line therefore leads with **when it was last counted and by whom**, and
carries a stripe for it: green under a week, amber under a month, red beyond
that or never counted. The summary counts how many have gone unchecked for a
month, which is the number worth watching.

**Everything sits on a pallet.** The room is organised by category, and a
category occupies one pallet or several, so the list is grouped that way and
ordered the way you walk it — counting follows your feet rather than the
alphabet. **Manage pallets** adds categories, records which pallets each one
covers, and nudges them up or down into walking order.

Anything not yet assigned collects under **Not on a pallet yet** at the end, in
red, so it reads as a job rather than a silent gap. Searching flattens the
groups: you want the item, not the tour. Removing a category leaves its items
behind in that pile rather than taking them with it.

**Cases and loose units are counted separately.** Most stock moves by the case,
but people pick at some of it, so an item can say what is inside one — 24 bottles
to a case — and then reads as `5 cases + 9 bottles`, with the total underneath.
That is what is on the shelf; `5.375 cases` is not.

Taking loose units opens a case when none are loose, exactly as it happens out
there: 8 cases, someone wants 3 bottles, and it becomes 7 cases + 21 bottles.
Counting records what was seen and is not quietly restated — 5 cases and 30 loose
stays that, rather than being rewritten as 6 and 6.

An item added without a pack size stays case-only; the Update panel offers to set
one later for anything that turns out to get picked at.

Three movements, and the difference between them matters:

- **I counted it** — sets the quantity *and* resets its age. The only one that
  does, because it is the only one where somebody looked.
- **Dropped off** — adds to the quantity. Stock moved; nobody audited the rest.
- **Took to store** — subtracts, never below zero.

Each writes a line to the movement log with who and when, so "who took the last
two cases" has an answer. Stock lives in `warehouse_stock`, separate from
`counts`, so **Reset never touches it** — the ordering counts are a scratch pad
wiped each round, and this is a standing record.

## Connecting Vori

Vori counts every unit the business owns, wherever it sits. The warehouse tab
counts one location. Subtract the second from the first and what is left is what
should be at the store — the number nobody currently has:

```
Vori, all in   −   warehouse   =   at the store
     200              129              71
```

**Setting it up.** Create a **read-only** API key at
[app.vori.com/retail/api-keys](https://app.vori.com/retail/api-keys), then add it
in Railway as `VORI_API_KEY`. Optionally set `VORI_STORE_ID` and
`VORI_SYNC_MINUTES` (default 30). Nothing here ever writes to Vori.

Then link each warehouse line to the Vori product it is — free-text names cannot
be matched to product IDs on their own — with the **Link** button on the item.

The middle figure is **everything held away from the store**, not just the place
on screen. A product kept in both the warehouse and cold storage is subtracted
once in full, so both tabs give the same answer instead of each ignoring the
other and overstating the store.

**Three things stop a comparison, and each says so rather than guessing:**

- Not linked to a Vori product yet.
- No pack size, so cases cannot be compared with whatever Vori counts in.
- More held offsite than Vori says exists at all, which means one of the two is
  out of date. It shows `?` and says so instead of printing a negative.
- Another place holding the same product without a pack size, so the total held
  cannot be worked out.

**On trusting the result.** Vori's on-hand is a perpetual count driven by sales
and receiving, and it drifts. A difference is only as good as the older of the
two numbers behind it, so both carry their age. Treat a figure with a
three-week-old warehouse count as the guess it is.

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

- **single**: `order = par(today) − counted`, floored at 0. Meat and fish count
  in half units, so the steppers move by 0.5.
- **shelf_cooler**: `order = (shelf_target − shelf) + (cooler_par(today) − cooler)`,
  each piece floored at 0. Produce counts in quarters — the shelf is empty, half
  or full, and the cooler stepper moves by 0.25.

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

**Settings → Backup** saves one file holding every item, PAR, vendor, count,
route and past order, across all three departments.

Deploying never removes anything — the schema step only creates what is missing
and adds columns, and seeding only fills a department holding no rows. So a
backup matters for the one thing that does delete: clearing a department on
purpose to load a fresh list.

To put one back:

```bash
DATABASE_URL="postgres://..." node scripts/restore.mjs dat-moi-backup-2026-08-20.json --yes
```

It replaces everything in the database, so it refuses without `--yes`, and it
runs as a single transaction — if any row fails, nothing is changed at all.

Railway's Postgres plugin also supports its own scheduled snapshots from the
dashboard. Worth turning on as well, since it covers losing the database itself
rather than its contents.
