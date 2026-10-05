/**
 * Household supplies: the actions that talk to the pantry and shopping APIs.
 * index.js owns the state and the events and hands them in through `deps`;
 * every action checks `signal.aborted` after each await before touching state.
 */

import { api } from '/api.js';
import { announceTransfer } from '/utils/kitchen-transfer.js';
import { writeMarker, productKey, findByName, applyDelta, mergeItem, roundQty } from './logic.js';

const num = (v) => (v === null || v === undefined || v === '' ? null : roundQty(v));

/**
 * @param {object} deps
 * @param {object}   deps.state      the page state (items, prefs, lists, prompt, lastBatch, panel)
 * @param {AbortSignal} deps.signal
 * @param {Function} deps.tx         module translation
 * @param {Function} deps.qtyLabel   "3 pcs"
 * @param {Function} deps.products   () => grouped products
 * @param {Function} deps.announce   text for the aria-live region
 * @param {Function} deps.toast      showToast guarded by the signal
 * @param {Function} deps.withBusy   (key, fn) => Promise, marks a product busy while fn runs
 */
export function createActions({ state, signal, tx, qtyLabel, products, announce, toast, withBusy }) {
  const findProduct = (key) => products().find((p) => p.key === key);

  // PATCH one batch and apply the server's row into the list: no full reload.
  async function patchQuantity(batch, quantity) {
    const res = await api.patch(`/pantry/${batch.id}`, { quantity });
    if (signal.aborted) return;
    state.items = mergeItem(state.items, res.data ?? { ...batch, quantity });
    const p = findProduct(productKey(batch));
    if (p) announce(`${p.name}: ${qtyLabel(p.total, p.unit)}`);
  }

  async function changeBatch(product, batch, delta) {
    const previous = Number(batch.quantity);
    const { next, promptAmount } = applyDelta(product, batch, delta);
    await patchQuantity(batch, next);
    if (signal.aborted) return;
    if (delta < 0) state.lastBatch[product.key] = batch.id;
    if (promptAmount > 0) state.prompt = { key: product.key, amount: promptAmount };
    navigator.vibrate?.(8);
    const where = batch.location_name || tx('noLocation');
    const qty = qtyLabel(Math.abs(delta), product.unit);
    toast(tx(delta < 0 ? 'took' : 'put', { name: product.name, qty, where }), 'default', 4000, () => {
      if (state.prompt?.key === product.key) state.prompt = null;
      withBusy(product.key, () => patchQuantity(batch, previous));
    });
  }

  async function ensureLists() {
    if (!state.lists) state.lists = (await api.get('/shopping')).data ?? [];
    return state.lists;
  }

  async function sendToShopping(product, amount) {
    const lists = await ensureLists();
    if (signal.aborted) return;
    if (!lists.length) { toast(tx('noLists'), 'warning'); return; }
    // The list chosen in the module settings, otherwise the first list.
    const list = lists.find((l) => l.id === state.prefs.listId) ?? lists[0];
    const res = await api.post(`/shopping/${list.id}/import-pantry`, {
      items: [{ pantry_item_id: product.primary.id, quantity: qtyLabel(amount, product.unit) }],
    });
    if (signal.aborted) return;
    const { added = 0, added_ids: addedIds = [] } = res.data ?? {};
    if (!added) toast(tx('alreadyOnList'), 'info');
    else announceTransfer({ message: tx('addedToList', { name: product.name, list: list.name }), addedIds });
  }

  async function saveLevels(product, min, target) {
    const notes = writeMarker(product.primary.notes, { min, target });
    const patches = [api.patch(`/pantry/${product.primary.id}`, { notes })];
    // With a marker minimum the module owns the product minimum: a minimum the
    // core page stored on a single batch would mark that batch low on its own.
    if (min !== null) {
      for (const b of product.batches) {
        if (b.min_quantity !== null && b.min_quantity !== undefined) patches.push(api.patch(`/pantry/${b.id}`, { min_quantity: null }));
      }
    }
    await Promise.all(patches);
  }

  async function saveLevelsForm(form) {
    const product = findProduct(form.dataset.key);
    if (!product) throw new Error('product gone');
    const data = new FormData(form);
    await saveLevels(product, num(data.get('min')), num(data.get('target')));
  }

  async function addItem(form) {
    const data = new FormData(form);
    const base = state.panel?.addTo ? findProduct(state.panel.addTo) : null;
    const name = (base?.name ?? String(data.get('name') ?? '')).trim();
    if (!name) return;
    // A typed name that already exists joins that product (same unit and category).
    const existing = base ?? findByName(products(), name);
    const body = {
      name: existing?.name ?? name,
      quantity: num(data.get('quantity')) ?? 1,
      unit: existing?.unit ?? data.get('unit'),
      category: existing?.category ?? data.get('category'),
      location_id: data.get('location_id') ? Number(data.get('location_id')) : null,
      expires_on: data.get('expires_on') || null,
    };
    const min = base ? null : num(data.get('min'));
    const target = base ? null : num(data.get('target'));
    if (!existing && (min !== null || target !== null)) body.notes = writeMarker(null, { min, target });
    await api.post('/pantry', body);
    if (signal.aborted) return;
    if (existing && !base && (min !== null || target !== null)) {
      await saveLevels(existing, min ?? existing.min, target ?? existing.target);
    }
  }

  return { changeBatch, ensureLists, sendToShopping, saveLevelsForm, addItem };
}
