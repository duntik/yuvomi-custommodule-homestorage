import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TEXT, parseMarker, writeMarker, groupProducts, productStatus, restockAmount,
  crossedMinimum, pickBatchForTake, pickBatchForPut, filterProducts, stepFor, roundQty,
  productKey, findByName, applyDelta, mergeItem, daysUntil, expiryStatus, expiresSoon,
  parseCategoryList,
} from '../modules/household-supplies/logic.js';

const row = (over) => ({
  id: 1, name: 'Toothpaste', unit: 'pcs', quantity: 1, category: 'Drogerie',
  location_id: null, expires_on: null, min_quantity: null, notes: null, ...over,
});

/* ---------- marker ---------- */

test('marker round-trips and keeps the user text', () => {
  const notes = writeMarker('bought at Costco', { min: 3, target: 12 });
  assert.equal(notes, 'bought at Costco [stock min=3 target=12]');
  assert.deepEqual(parseMarker(notes), { rest: 'bought at Costco', min: 3, target: 12, hasMarker: true });
});

test('marker alone, partial marker, and removing it', () => {
  assert.equal(writeMarker(null, { target: 12 }), '[stock target=12]');
  assert.equal(parseMarker('[stock target=12]').min, null);
  assert.equal(writeMarker('note [stock min=3]', {}), 'note');
  assert.equal(writeMarker('[stock min=3]', {}), null);
});

test('garbage in the marker is ignored, not trusted', () => {
  const m = parseMarker('[stock min=-4 target=abc]');
  assert.equal(m.hasMarker, true);
  assert.equal(m.min, null);
  assert.equal(m.target, null);
});

test('text that merely contains brackets is not a marker', () => {
  assert.equal(parseMarker('use [blue] cap').hasMarker, false);
});

test('a marker needs at least one key=value pair and must end the note', () => {
  assert.equal(parseMarker('[stock]').hasMarker, false);
  assert.equal(parseMarker('[stock foo]').hasMarker, false);
  assert.equal(parseMarker('[stock min=3] trailing text').hasMarker, false);
  assert.equal(parseMarker('[stock min=3]\n').hasMarker, true);
  assert.equal(parseMarker('[stock min=3]\n').min, 3);
  // Writing over a note that only looks like a marker keeps that text.
  assert.equal(writeMarker('[stock]', { min: 2 }), '[stock] [stock min=2]');
});

test('multi-line notes survive the round trip', () => {
  const text = 'first line\nsecond line\n\nthird';
  const notes = writeMarker(text, { min: 1 });
  assert.equal(notes, `${text} [stock min=1]`);
  assert.equal(parseMarker(notes).rest, text);
  assert.equal(writeMarker(notes, {}), text);
});

test('notes are capped at MAX_TEXT including the marker', () => {
  const long = 'x'.repeat(MAX_TEXT + 50);
  const notes = writeMarker(long, { min: 3, target: 12 });
  assert.ok(notes.length <= MAX_TEXT);
  assert.ok(notes.endsWith(' [stock min=3 target=12]'));
  assert.equal(parseMarker(notes).min, 3);
  assert.equal(writeMarker(long, {}).length, MAX_TEXT, 'without a marker the text itself is capped');
  // A note that fits is not touched.
  const fits = 'y'.repeat(MAX_TEXT - 30);
  assert.equal(writeMarker(fits, { min: 1 }), `${fits} [stock min=1]`);
});

/* ---------- grouping ---------- */

test('batches with the same name and unit form one product, summed', () => {
  const products = groupProducts([
    row({ id: 1, quantity: 1 }),
    row({ id: 2, name: 'toothpaste ', quantity: 8, notes: '[stock min=3 target=12]' }),
    row({ id: 3, name: 'Toothpaste', unit: 'pkg', quantity: 2 }),
  ]);
  assert.equal(products.length, 2);
  const pcs = products.find((p) => p.unit === 'pcs');
  assert.equal(pcs.total, 9);
  assert.equal(pcs.min, 3);
  assert.equal(pcs.target, 12);
  assert.equal(pcs.primary.id, 2, 'the batch holding the marker is the primary');
});

test('grouping ignores case beyond ASCII', () => {
  const [p] = groupProducts([row({ id: 1, name: 'Spülmittel' }), row({ id: 2, name: 'SPÜLMITTEL', quantity: 2 })]);
  assert.equal(p.total, 3);
  // Turkish capital I with dot: lowercasing is stable, so two rows spelt the
  // same way always land in the same product.
  const key = productKey({ name: 'İstanbul', unit: 'pcs' });
  assert.equal(productKey({ name: 'İstanbul'.toLocaleLowerCase(), unit: 'pcs' }), key);
  assert.equal(groupProducts([row({ id: 1, name: 'İstanbul' }), row({ id: 2, name: 'İSTANBUL' })]).length, 1);
});

test('product key without a unit is still well formed', () => {
  assert.equal(productKey({ name: ' Soap ' }), '|soap');
  assert.equal(productKey({}), '|');
});

test('mixed categories: the majority wins, ties go to the marked batch', () => {
  const [majority] = groupProducts([
    row({ id: 1, category: 'Lebensmittel', notes: '[stock min=1]' }),
    row({ id: 2, category: 'Drogerie' }),
    row({ id: 3, category: 'Drogerie' }),
  ]);
  assert.equal(majority.category, 'Drogerie');
  const [tie] = groupProducts([
    row({ id: 1, category: 'Lebensmittel' }),
    row({ id: 2, category: 'Drogerie', notes: '[stock min=1]' }),
  ]);
  assert.equal(tie.category, 'Drogerie', 'the marked batch is the primary');
  const [oldest] = groupProducts([row({ id: 1, category: 'Haushalt' }), row({ id: 2, category: 'Drogerie' })]);
  assert.equal(oldest.category, 'Haushalt', 'without a marker the oldest batch is the primary');
});

test('1 in the bathroom and 8 in the attic with minimum 3 is not low', () => {
  const [p] = groupProducts([row({ id: 1, quantity: 1, min_quantity: 3 }), row({ id: 2, quantity: 8 })]);
  assert.equal(productStatus(p), 'ok');
});

test('core min_quantity is honoured when no marker exists', () => {
  const [p] = groupProducts([row({ quantity: 2, min_quantity: 3 })]);
  assert.equal(p.min, 3);
  assert.equal(productStatus(p), 'low');
});

test('findByName ignores case and spaces', () => {
  const products = groupProducts([row({ name: 'Toothpaste' })]);
  assert.equal(findByName(products, '  toothPASTE ').name, 'Toothpaste');
  assert.equal(findByName(products, 'tooth'), null);
  assert.equal(findByName(products, ''), null);
});

/* ---------- levels ---------- */

test('restock goes up to the target, falls back to the minimum', () => {
  assert.equal(restockAmount({ total: 3, min: 3, target: 12 }), 9);
  assert.equal(restockAmount({ total: 2, min: 3, target: null }), 1);
  assert.equal(restockAmount({ total: 3, min: 3, target: null }), 0);
  assert.equal(restockAmount({ total: 20, min: 3, target: 12 }), 0);
  assert.equal(restockAmount({ total: 1, min: null, target: null }), 0);
});

test('restock with floats rounds like the pantry', () => {
  assert.equal(restockAmount({ total: 0.7, min: null, target: 1.5 }), 0.8);
  assert.equal(restockAmount({ total: 0.1, min: 0.3, target: null }), 0.2);
});

test('status: empty, low, ok', () => {
  assert.equal(productStatus({ total: 0, min: null }), 'empty');
  assert.equal(productStatus({ total: 3, min: 3 }), 'low');
  assert.equal(productStatus({ total: 4, min: 3 }), 'ok');
  assert.equal(productStatus({ total: 1, min: null }), 'ok');
});

test('the prompt fires only when crossing the minimum', () => {
  assert.equal(crossedMinimum(4, 3, 3), true);
  assert.equal(crossedMinimum(3, 2, 3), false, 'already low before');
  assert.equal(crossedMinimum(5, 4, 3), false);
  assert.equal(crossedMinimum(4, 3, null), false);
});

test('a minimum of 0 fires when the last one is taken', () => {
  assert.equal(crossedMinimum(1, 0, 0), true);
  assert.equal(crossedMinimum(2, 1, 0), false);
  assert.equal(productStatus({ total: 0, min: 0 }), 'empty');
});

test('applyDelta computes the next quantity, the total and the prompt amount', () => {
  const product = { key: 'pcs|toothpaste', total: 4, min: 3, target: 12, batches: [] };
  const batch = row({ quantity: 1 });
  assert.deepEqual(applyDelta(product, batch, -1), { next: 0, after: 3, promptAmount: 9 });
  assert.deepEqual(applyDelta(product, batch, 1), { next: 2, after: 5, promptAmount: 0 });
  assert.deepEqual(applyDelta({ ...product, total: 3 }, batch, -1), { next: 0, after: 2, promptAmount: 0 }, 'already low: no prompt');
  assert.deepEqual(applyDelta({ ...product, min: null, target: null }, batch, -1), { next: 0, after: 3, promptAmount: 0 });
  assert.equal(applyDelta(product, row({ quantity: 0.3 }), -0.5).next, 0, 'never negative');
});

test('mergeItem applies a PATCH response without touching the other rows', () => {
  const items = [row({ id: 1, quantity: 1 }), row({ id: 2, quantity: 8 })];
  const merged = mergeItem(items, { id: 2, quantity: 7 });
  assert.equal(merged[1].quantity, 7);
  assert.equal(merged[1].name, 'Toothpaste', 'fields the response does not carry stay');
  assert.equal(merged[0], items[0]);
  assert.equal(mergeItem(items, { id: 3, quantity: 1 }).length, 3, 'unknown rows are appended');
  assert.equal(mergeItem(items, null), items);
});

/* ---------- picking batches ---------- */

test('take from the batch that expires first, then the smallest', () => {
  const pick = pickBatchForTake([
    row({ id: 1, quantity: 8 }),
    row({ id: 2, quantity: 1 }),
    row({ id: 3, quantity: 5, expires_on: '2026-10-05' }),
    row({ id: 4, quantity: 0, expires_on: '2026-01-01' }),
  ]);
  assert.equal(pick.id, 3);
  assert.equal(pickBatchForTake([row({ id: 1, quantity: 8 }), row({ id: 2, quantity: 1 })]).id, 2);
  assert.equal(pickBatchForTake([row({ quantity: 0 })]), null);
});

test('take: same expiry goes to the smallest batch, then the oldest', () => {
  const same = [
    row({ id: 1, quantity: 5, expires_on: '2026-12-01' }),
    row({ id: 2, quantity: 2, expires_on: '2026-12-01' }),
    row({ id: 3, quantity: 2, expires_on: '2026-12-01' }),
  ];
  assert.equal(pickBatchForTake(same).id, 2);
});

test('put goes to the batch -1 last took from, else the one that expires last / largest', () => {
  const batches = [
    row({ id: 1, quantity: 1, expires_on: '2026-11-01' }),
    row({ id: 2, quantity: 8 }),
    row({ id: 3, quantity: 9, expires_on: '2027-01-01' }),
  ];
  assert.equal(pickBatchForPut(batches, 1).id, 1, 'the tube in use');
  assert.equal(pickBatchForPut(batches, '1').id, 1, 'ids from data-* attributes are strings');
  assert.equal(pickBatchForPut(batches, 99).id, 2, 'unknown last batch: no expiry counts as expiring last');
  assert.equal(pickBatchForPut(batches, null).id, 2);
  assert.equal(pickBatchForPut([row({ id: 1, quantity: 1 }), row({ id: 2, quantity: 8 })]).id, 2, 'largest');
  assert.equal(pickBatchForPut([]), null);
});

test('step sizes match the core pantry', () => {
  assert.equal(stepFor('pcs'), 1);
  assert.equal(stepFor('g'), 100);
  assert.equal(stepFor('kg'), 0.5);
  assert.equal(stepFor('bottle'), 1);
  assert.equal(stepFor(undefined), 1, 'unknown unit');
});

test('roundQty: two decimals, never negative, garbage is 0', () => {
  assert.equal(roundQty(1.005), 1);
  assert.equal(roundQty('2.555'), 2.56);
  assert.equal(roundQty(-3), 0);
  assert.equal(roundQty('abc'), 0);
  assert.equal(roundQty(null), 0);
});

/* ---------- filtering ---------- */

test('views split by household categories; unknown categories count as food', () => {
  const products = groupProducts([
    row({ id: 1, name: 'Toothpaste', category: 'Drogerie' }),
    row({ id: 2, name: 'Milk', category: 'Milchprodukte', quantity: 0 }),
  ]);
  const cats = ['Drogerie', 'Haushalt'];
  assert.deepEqual(filterProducts(products, { view: 'household', householdCategories: cats }).map((p) => p.name), ['Toothpaste']);
  assert.deepEqual(filterProducts(products, { view: 'food', householdCategories: cats }).map((p) => p.name), ['Milk']);
  assert.equal(filterProducts(products, { view: 'all', status: 'low' }).length, 1);
  assert.equal(filterProducts(products, { view: 'all', query: 'tooth' }).length, 1);
});

test('the low filter includes empty products; a whitespace query matches everything', () => {
  const products = groupProducts([
    row({ id: 1, name: 'Empty', quantity: 0 }),
    row({ id: 2, name: 'Low', quantity: 1, min_quantity: 2 }),
    row({ id: 3, name: 'Fine', quantity: 5 }),
  ]);
  assert.deepEqual(filterProducts(products, { view: 'all', status: 'low' }).map((p) => p.name), ['Empty', 'Low']);
  assert.equal(filterProducts(products, { view: 'all', query: '   ' }).length, 3);
  assert.equal(filterProducts(products, { view: 'all', query: ' LOW ' }).length, 1);
});

test('product key survives a round trip through an HTML attribute', () => {
  const key = groupProducts([row({ name: 'Zahnpasta | Mint' })])[0].key;
  assert.match(key, /^[\x20-\x7E -￼]+$/, 'printable only, no control characters');
  assert.equal(key, 'pcs|zahnpasta | mint');
});

/* ---------- expiry ---------- */

test('daysUntil counts calendar days from a date key', () => {
  assert.equal(daysUntil('2026-10-12', '2026-10-05'), 7);
  assert.equal(daysUntil('2026-10-04', '2026-10-05'), -1);
  assert.equal(daysUntil('2026-10-05', '2026-10-05'), 0);
  assert.equal(daysUntil('2027-03-01', '2026-03-01'), 365);
  assert.equal(daysUntil(null, '2026-10-05'), null);
  assert.equal(daysUntil('soon', '2026-10-05'), null);
});

test('expiresSoon: within 7 days or already past', () => {
  assert.equal(expiryStatus('2026-10-12', '2026-10-05'), 'soon');
  assert.equal(expiryStatus('2026-10-13', '2026-10-05'), null);
  assert.equal(expiryStatus('2026-10-01', '2026-10-05'), 'expired');
  assert.equal(expiresSoon('2026-10-06', '2026-10-05'), true);
  assert.equal(expiresSoon(null, '2026-10-05'), false);
  assert.equal(expiresSoon('2026-10-20', '2026-10-05', 30), true, 'custom window');
});

test('widget option: household categories from a comma separated string', () => {
  assert.deepEqual(parseCategoryList('Haushalt, Drogerie ,,Bad'), ['Haushalt', 'Drogerie', 'Bad']);
  assert.deepEqual(parseCategoryList('', ['Haushalt']), ['Haushalt']);
  assert.deepEqual(parseCategoryList(undefined, ['Haushalt']), ['Haushalt']);
});
