# Household supplies for Yuvomi

A third-party module for [Yuvomi](https://github.com/ulsklyc/yuvomi) that gives household consumables (toothpaste, toilet paper, dishwasher tablets, anything that runs out) their own page, built on Yuvomi's pantry.

## What it does

- A "Supplies" entry in the navigation, separate from the kitchen tabs.
- Pantry rows with the same name and unit are grouped into one product: "Toothpaste 9 pcs: bathroom 1, attic 8".
- Minimum and target per product. The minimum is compared with the sum of all batches, so 1 in the bathroom plus 8 in the attic is not low.
- Steppers in the list. "-1" takes from the batch that expires first, then from the smallest; "+1" goes back to the batch "-1" last took from. Every tap has an Undo in its toast.
- When a product reaches its minimum the row offers "Add 9 to shopping?" (target minus current). The hand-over goes to the Yuvomi shopping list with Undo.
- Views Household / Food / All, a "Running low" filter with a count, and search.
- Expiry dates in the user's date format, with "expires soon" (7 days) and "expired" badges.
- Members with read-only pantry access see the list without steppers or forms.
- A "Running low" dashboard widget.
- Translations: English, German, Russian.

## How data is stored

The module stores nothing of its own. Every batch is a regular row in Yuvomi's pantry (`/api/v1/pantry`), so the data is shared with the household, shows up in the core pantry page, and survives removing the module.

The product-level minimum and target live in a marker at the end of the notes of one batch:

```
bought in bulk [stock min=3 target=12]
```

The marker is the last thing in the note and needs at least one `key=value` pair; a note that merely contains "[stock]" is left alone. Notes are capped at Yuvomi's 5000 characters including the marker.

When a minimum is saved here, the module takes over the minimum of the grouped product: a `min_quantity` that the core pantry page stored on a single batch is cleared, because a per-batch minimum would mark that batch low on its own. Without a marker, the largest per-batch minimum is honoured.

Personal settings (the selected view, which categories count as household, which shopping list to use) are stored in the browser of each device, not on the server.

## Install

Requires Yuvomi 2.63 or newer (for the dashboard widget).

**From the settings** (once [ulsklyc/yuvomi#1671](https://github.com/ulsklyc/yuvomi/pull/1671) ships): Settings -> Modules -> Add custom module, with the repository URL

```
https://github.com/duntik/yuvomi-custommodule-homestorage
```

The module is installed disabled; switch it on under Settings -> Modules -> Active modules.

**By hand** (works today): copy `modules/household-supplies` into Yuvomi's modules folder on the server (for Docker Compose that is `./modules/` next to `docker-compose.yml`). No restart is needed; the module appears under Active modules within a minute.

Members need access to the Pantry module to see the page, write access to change quantities, and write access to Shopping for the hand-over to the shopping list.

## Dashboard widget

"Running low" lists the products at or below their minimum (and empty ones), with a "-1" per row for members who may write to the pantry. It is hidden by default; enable it in the dashboard's customise mode. Options: the household categories (comma separated) and which view to show (household, food, all). A 1-wide tile shows 4 rows, a 2-wide tile 8.

## Settings

The module's Settings button chooses which pantry categories count as household (everything else is Food) and, if there is more than one shopping list, which list the hand-over uses. Both are per device.

## Development

```
npm test                          # logic and view tests (node:test, no browser)
node scripts/check-locales.mjs    # every key used exists in every locale, no unused keys
```

```
modules/household-supplies/   the module, the only folder Yuvomi needs
  module.json                 manifest (menu, permissions, widget)
  index.js                    page state and event handlers
  view.js                     HTML renderers, pure functions of (state, ctx)
  actions.js                  the pantry and shopping API calls
  logic.js                    grouping, marker, levels, batch picking; pure
  widgets/low-stock.js        dashboard widget
  style.css                   styles on Yuvomi's design tokens
  locales/                    en, de, ru
test/                         logic.test.js, view.test.js
scripts/check-locales.mjs     locale consistency check
```

The page uses only Yuvomi's public helpers (`/api.js`, `/i18n.js`, `/utils/...`), renders with HTML strings through `esc()`, and passes the page's `signal` to every listener.

## Versioning

Releases are tagged (`v0.2.0`); the installer in Yuvomi's settings picks the latest release. The `version` in `module.json` matches the tag.

## License

MIT, see `LICENSE`.
