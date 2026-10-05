import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  renderBody, renderProduct, renderPrompt, renderPanel, renderUnitOptions, nameHint, detailId, focusSelector,
} from '../modules/household-supplies/view.js';
import { groupProducts } from '../modules/household-supplies/logic.js';

const en = JSON.parse(readFileSync(new URL('../modules/household-supplies/locales/en.json', import.meta.url), 'utf8'));
const fill = (str, params = {}) => str.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in params ? String(params[k]) : m));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CORE = { 'pantry.units.pcs': 'pcs', 'pantry.units.g': 'g', 'pantry.units.kg': 'kg' };

function ctx(over = {}) {
  return {
    tx: (key, params) => fill(en[key] ?? key, params),
    t: (key) => CORE[key] ?? key,
    esc,
    fmt: (n) => String(n),
    qtyLabel: (n, unit) => `${n} ${unit}`,
    categoryLabel: (name) => name,
    formatDate: (key) => key.split('-').reverse().join('.'),
    units: ['pcs', 'g', 'kg', 'pkg', 'bottle'],
    canWrite: true,
    canShop: true,
    today: '2026-10-05',
    ...over,
  };
}

const row = (over) => ({
  id: 1, name: 'Toothpaste', unit: 'pcs', quantity: 1, category: 'Drogerie',
  location_id: null, location_name: null, expires_on: null, min_quantity: null, notes: null, ...over,
});

function state(items, over = {}) {
  return {
    prefs: { view: 'all', householdCategories: ['Drogerie', 'Haushalt'], listId: null },
    items, locations: [], categories: [{ name: 'Drogerie' }, { name: 'Haushalt' }], lists: null,
    lowOnly: false, query: '', open: new Set(), busy: new Set(),
    panel: null, prompt: null, lastBatch: {}, draftName: '', error: null, ...over,
  };
}

const product = (items) => groupProducts(items)[0];

test('product row shows a badge for low and empty, none when fine', () => {
  const low = renderProduct(product([row({ quantity: 2, notes: '[stock min=3]' })]), state([]), ctx());
  assert.match(low, /hs-badge--low">low</);
  const empty = renderProduct(product([row({ quantity: 0 })]), state([]), ctx());
  assert.match(empty, /hs-badge--empty">out</);
  const ok = renderProduct(product([row({ quantity: 9 })]), state([]), ctx());
  assert.doesNotMatch(ok, /hs-badge/);
});

test('read-only members see quantities but no steppers or edit actions', () => {
  const p = product([row({ quantity: 2, notes: '[stock min=3 target=9]' })]);
  const st = state([], { open: new Set([p.key]) });
  const html = renderProduct(p, st, ctx({ canWrite: false, canShop: false }));
  assert.doesNotMatch(html, /data-act="take"|data-act="put"|data-act="batch-dec"|data-act="batch-inc"/);
  assert.doesNotMatch(html, /data-act="edit"|data-act="add-batch"|data-act="shop"/);
  assert.match(html, /2 pcs/, 'the quantity is still shown');
  const writer = renderProduct(p, st, ctx());
  assert.match(writer, /data-act="take"/);
  assert.match(writer, /data-act="shop"/);
  assert.match(writer, /data-act="edit"/);
});

test('the shopping hand-over needs shopping write access, not pantry access', () => {
  const p = product([row({ quantity: 2, notes: '[stock min=3 target=9]' })]);
  const st = state([], { open: new Set([p.key]) });
  const html = renderProduct(p, st, ctx({ canWrite: true, canShop: false }));
  assert.match(html, /data-act="take"/);
  assert.doesNotMatch(html, /data-act="shop"/);
});

test('the low-stock prompt renders inside the product li', () => {
  const p = product([row({ quantity: 3, notes: '[stock min=3 target=12]' })]);
  const st = state([], { prompt: { key: p.key, amount: 9 } });
  const html = renderProduct(p, st, ctx());
  const li = html.indexOf('<li class="hs-item"');
  const prompt = html.indexOf('<div class="hs-prompt" role="status">');
  const end = html.lastIndexOf('</li>');
  assert.ok(li >= 0 && prompt > li && prompt < end, 'prompt sits between <li> and </li>');
  assert.match(html, /Toothpaste is running low/);
  assert.match(html, /Add 9 pcs to shopping\?/);
  assert.match(html, /data-act="prompt-yes"/);
  // Another product does not show it.
  assert.equal(renderPrompt(product([row({ name: 'Soap' })]), st, ctx()), '');
});

test('the toggle button controls the detail element', () => {
  const p = product([row()]);
  const closed = renderProduct(p, state([]), ctx());
  const id = detailId(p.key);
  assert.match(closed, new RegExp(`aria-controls="${id}"`));
  assert.match(closed, new RegExp(`id="${id}" hidden`));
  assert.match(closed, /aria-expanded="false"/);
  const open = renderProduct(p, state([], { open: new Set([p.key]) }), ctx());
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /hs-batches/);
  assert.match(id, /^[A-Za-z][\w-]*$/, 'a valid id');
});

test('expiry: formatted date and a badge within 7 days, expired past today', () => {
  const p = product([
    row({ id: 1, quantity: 1, expires_on: '2026-10-10', location_name: 'Bathroom' }),
    row({ id: 2, quantity: 5, expires_on: '2027-01-01', location_name: 'Attic' }),
  ]);
  const html = renderProduct(p, state([], { open: new Set([p.key]) }), ctx());
  assert.match(html, /until 10\.10\.2026/);
  assert.match(html, /until 01\.01\.2027/);
  assert.equal(html.match(/expires soon/g).length, 2, 'one badge on the row, one on the batch');
  const past = renderProduct(product([row({ expires_on: '2026-09-30' })]), state([]), ctx());
  assert.match(past, /hs-badge--empty">expired</);
  const fine = renderProduct(product([row({ expires_on: '2026-12-24' })]), state([]), ctx());
  assert.doesNotMatch(fine, /expires soon|expired/);
});

test('unit select falls back to the raw unit when the core has no label', () => {
  const html = renderUnitOptions('pkg', ctx());
  assert.match(html, /<option value="pcs" >pcs<\/option>/);
  assert.match(html, /<option value="pkg" selected>pkg<\/option>/);
  assert.match(html, /<option value="bottle" >bottle<\/option>/);
  const labelled = renderUnitOptions('pcs', ctx({ t: (k) => (k === 'pantry.units.pcs' ? 'Stück' : k) }));
  assert.match(labelled, />Stück</);
});

test('typing an existing name in New item shows the join hint', () => {
  const items = [row({ name: 'Toothpaste', category: 'Drogerie' })];
  const products = groupProducts(items);
  assert.equal(nameHint('toothpaste', products, ctx()), 'Joins "Toothpaste" as a new batch and takes its unit (pcs) and category (Drogerie).');
  assert.equal(nameHint('Soap', products, ctx()), '');
  const html = renderPanel(state(items, { panel: 'add', draftName: 'TOOTHPASTE' }), ctx());
  assert.match(html, /id="hs-name-hint" >Joins &quot;Toothpaste&quot;/);
  const none = renderPanel(state(items, { panel: 'add', draftName: 'Soap' }), ctx());
  assert.match(none, /id="hs-name-hint" hidden>/);
  const batch = renderPanel(state(items, { panel: { addTo: products[0].key } }), ctx());
  assert.doesNotMatch(batch, /hs-name-hint/, 'adding a batch has no name to type');
  assert.match(batch, /readonly/);
});

test('body: toolbar with a low count, list, empty states and errors', () => {
  const items = [
    row({ id: 1, name: 'Toothpaste', quantity: 0 }),
    row({ id: 2, name: 'Soap', quantity: 1, notes: '[stock min=2]' }),
    row({ id: 3, name: 'Tabs', quantity: 9 }),
  ];
  const html = renderBody(state(items), ctx());
  assert.match(html, /hs-chip__count">2</);
  assert.equal(html.match(/<li class="hs-item"/g).length, 3);
  assert.equal(renderBody(state(items, { lowOnly: true }), ctx()).match(/<li class="hs-item"/g).length, 2);
  assert.match(renderBody(state(items, { query: 'zzz' }), ctx()), /Nothing matches this filter\./);
  assert.match(renderBody(state([]), ctx()), /Nothing here yet\./);
  assert.match(renderBody(state([], { error: 'Boom <b>' }), ctx()), /Boom &lt;b&gt;[\s\S]*data-act="reload"/);
});

test('everything from the data is escaped', () => {
  const p = product([row({ name: '<img src=x onerror=alert(1)>', location_name: '"quoted"', quantity: 1 })]);
  const html = renderProduct(p, state([], { open: new Set([p.key]) }), ctx());
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /"quoted"/);
});

test('focusSelector rebuilds the path to the focused control', () => {
  const escape = (s) => String(s).replace(/"/g, '\\"');
  assert.equal(focusSelector({ act: 'take', key: 'pcs|a' }, escape), '[data-key="pcs|a"] [data-act="take"]');
  assert.equal(focusSelector({ act: 'batch-inc', key: 'pcs|a', batch: '7' }, escape), '[data-key="pcs|a"] [data-batch="7"] [data-act="batch-inc"]');
  assert.equal(focusSelector({ act: 'view', view: 'food' }, escape), '[data-act="view"][data-view="food"]');
  assert.equal(focusSelector({}, escape), null);
});
