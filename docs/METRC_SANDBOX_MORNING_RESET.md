# Metrc sandbox — morning reset

**Validation environment only.** None of this applies to a production facility, where
rooms, items and opening inventory belong to the licensee and are created in Metrc.

## Why this exists

The Metrc **sandbox wipes packages every night.** A facility that was fully set up
yesterday wakes with nothing to package from, and every CannaQMS inventory lot points
at a package Metrc no longer has.

What survives the wipe:

| Thing | Survives? | Lives in |
|---|---|---|
| Customers / manifest recipients | ✅ yes | CannaQMS database |
| Transporter presets | ✅ yes | CannaQMS database |
| Batches, recipes, documents, training | ✅ yes | CannaQMS database |
| Metrc **items** (product catalogue) | ✅ usually | Metrc |
| Metrc **locations** (rooms) | ⚠️ unconfirmed | Metrc |
| Metrc **packages** | ❌ **wiped nightly** | Metrc |
| Metrc tag pool | ✅ yes | Metrc |

So the only thing that genuinely repeats is the Metrc side: a room, the items, and
some opening-balance packages to draw from.

## The one call

Signed in as Admin, paste this into the browser address bar:

```
https://cannaq-validation-production.up.railway.app/api/metrc/sandbox/morning-reset
```

It is **idempotent** — anything already present is left alone and reported as
"already there", so running it twice is harmless.

It refuses to run against a non-sandbox facility.

### Adding the items you package into

Items are only created if you name them. Each `item` is
`Name|category|unit|unit weight|weight unit` — the last two are optional. The category
is matched against **your facility's own allowed list**, so a partial name is fine:

```
/api/metrc/sandbox/morning-reset
  ?item=CannaQMS Pre-Roll 1g|Pre-Roll|Each
  &item=CannaQMS Gummy 100mg|Edible|Each
  &item=CannaQMS Vape Cart 1g|Vape|Each
```

If a category doesn't match, the response lists every category your facility allows —
use one of those next time.

**Some categories need a unit weight.** Metrc decides which, per state, and refuses the
create without it:

> The Unit's Weight is required for Item Category "Vape Cart", but it is a negative
> number or was not specified.

Add the weight and its unit as the last two parts:

```
/api/metrc/sandbox/morning-reset
  ?item=CannaQMS Vape Cart 1g|Vape|Each|1|Grams
```

Leave them off for categories that don't ask for them.

Other optional parameters: `room=` (default `Main Storage`), `packages=` (default 10).

## Then finish in the app

The reset deliberately does **not** touch inventory. Once it reports success:

1. Open **Inventory**
2. Click **Sync from Metrc**

That refreshes the lots against the new packages. It's left as a visible click rather
than something that happens invisibly inside a setup call.

## Reading the result

```json
{
  "ok": true,
  "steps": [
    { "step": "Storage room",    "done": "already there", "detail": "Main Storage" },
    { "step": "Item \"CannaQMS Pre-Roll 1g\"", "done": "created", "detail": "category Pre-Roll" },
    { "step": "Source packages", "done": "created" }
  ],
  "activePackagesNow": 10,
  "nextStep": "Open Inventory and click \"Sync from Metrc\"..."
}
```

Any step reading `FAILED` carries a `detail` saying what Metrc objected to. `ok` is
false if any step failed.

## What this is not

It does not create customers, transporters, batches or documents — those live in
CannaQMS and survive the night. It is only the Metrc side.
