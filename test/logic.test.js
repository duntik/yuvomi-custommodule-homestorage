import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarker, writeMarker, groupProducts, productStatus, restockAmount,
  crossedMinimum, pickBatchForTake, filterProducts, stepFor,
} from '../modules/household-supplies/logic.js';

const row = (over) => ({
  id: 1, name: 'Toothpaste', unit: 'pcs', quantity: 1, category: 'Drogerie',
  location_id: null, expires_on: null, min_quantity: null, notes: null, ...over,
});

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
  assert.equal(m.min, null);
  assert.equal(m.target, null);
});

test('text that merely contains brackets is not a marker', () => {
  assert.equal(parseMarker('use [blue] cap').hasMarker, false);
});

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

test('1 in the bathroom and 8 in the attic with minimum 3 is not low', () => {
  const [p] = groupProducts([row({ id: 1, quantity: 1, min_quantity: 3 }), row({ id: 2, quantity: 8 })]);
  assert.equal(productStatus(p), 'ok');
});

test('core min_quantity is honoured when no marker exists', () => {
  const [p] = groupProducts([row({ quantity: 2, min_quantity: 3 })]);
  assert.equal(p.min, 3);
  assert.equal(productStatus(p), 'low');
});

test('restock goes up to the target, falls back to the minimum', () => {
  assert.equal(restockAmount({ total: 3, min: 3, target: 12 }), 9);
  assert.equal(restockAmount({ total: 2, min: 3, target: null }), 1);
  assert.equal(restockAmount({ total: 3, min: 3, target: null }), 0);
  assert.equal(restockAmount({ total: 20, min: 3, target: 12 }), 0);
  assert.equal(restockAmount({ total: 1, min: null, target: null }), 0);
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

test('product key survives a round trip through an HTML attribute', () => {
  const key = groupProducts([row({ name: 'Zahnpasta | Mint' })])[0].key;
  assert.match(key, /^[\x20-\x7E -￼]+$/, 'printable only, no control characters');
  assert.equal(key, 'pcs|zahnpasta | mint');
});

test('step sizes match the core pantry', () => {
  assert.equal(stepFor('pcs'), 1);
  assert.equal(stepFor('g'), 100);
  assert.equal(stepFor('kg'), 0.5);
});
