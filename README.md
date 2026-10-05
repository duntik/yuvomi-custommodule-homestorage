# Household supplies for Yuvomi

A third-party module for [Yuvomi](https://github.com/ulsklyc/yuvomi) that gives household consumables their own page: toothpaste, toilet paper, dishwasher tablets, and other supplies you use up.

## Features

- A separate **Supplies** menu item outside the Kitchen page.
- Batches with the same name and unit grouped into one product, such as "Toothpaste: 9 units — bathroom: 1, attic: 8".
- A minimum and target stock level per product. The minimum is compared with the total across all batches.
- One-tap **−1** and **+1** buttons. Taking one unit uses the batch with the earliest expiry date first, then the smallest batch.
- A restocking prompt when stock reaches the minimum: "3 left. Add 9 to shopping?"
- **Household / Food / All** views and a **Running low** filter.
- An English interface.

## Data storage

The module does not maintain a separate inventory. Every batch is a regular Yuvomi pantry entry, so the data is shared with the household, remains visible in the standard Pantry section, and stays available if you uninstall the module.

The minimum and target are stored at the end of one batch's notes as `[stock min=3 target=12]`. Leave this marker intact.

Only personal preferences are saved on your device: the selected view, which categories count as household supplies, and which shopping list to use.

## Installation

### Through Yuvomi settings

If your Yuvomi version supports installing custom modules through the interface, open **Settings → Modules → Add custom module** and enter:

```text
https://github.com/duntik/yuvomi-custommodule-homestorage
```

The module is installed disabled. Enable it under **Settings → Modules → Active modules**.

### Manual installation

Copy `modules/household-supplies` into Yuvomi's modules directory on your server. For Docker Compose, this is `./modules/` next to `docker-compose.yml`. No restart is required; the module should appear under **Active modules** within about 30 seconds.

Household members need access to **Pantry**. Adding items to a shopping list also requires access to **Shopping**.

## Repository structure

```text
modules/household-supplies/  Module files installed into Yuvomi
  module.json                Module manifest
  index.js                   Page interface
  logic.js                   Calculations without UI or network access
  style.css                  Styles using Yuvomi design tokens
  locales/en.json            English interface strings
test/                        Logic tests
```

## Tests

```sh
npm test
```
