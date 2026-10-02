/**
 * Household supplies - a Yuvomi third-party module.
 *
 * A separate page for household consumables (toothpaste, toilet paper,
 * dishwasher tablets...). It stores nothing of its own: every item is a normal
 * row in Yuvomi's pantry, so the data is shared with the household and shows up
 * in the core pantry page too. See logic.js for the rules.
 */

import { api } from '/api.js';
import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { showToast } from '/utils/toast-show.js';
import { categoryLabel } from '/utils/shopping-categories.js';
import { PANTRY_UNITS, pantryQuantityLabel } from '/utils/pantry-units.js';
import { renderPageHeader, renderPageTitle, renderPageActions, renderPageBody, renderPageSection } from '/utils/page-layout.js';
import {
  writeMarker, groupProducts, productStatus, restockAmount,
  crossedMinimum, pickBatchForTake, stepFor, filterProducts, roundQty, productKey,
} from './logic.js';

const ID = 'household-supplies';
const STORE = `yuvomi-ext:${ID}`;
const DEFAULT_HOUSEHOLD = ['Haushalt', 'Drogerie'];

const tx = (key, params) => t(`extensions.${ID}.${key}`, params);
const fmt = (n) => getNumberFormat({ maximumFractionDigits: 2 }).format(n);
const qtyLabel = (n, unit) => pantryQuantityLabel(n, unit, { t, formatNumber: fmt });

/* ---------- per-person preferences (this device) ---------- */

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    return {
      view: ['household', 'food', 'all'].includes(raw.view) ? raw.view : 'household',
      householdCategories: Array.isArray(raw.householdCategories) ? raw.householdCategories : DEFAULT_HOUSEHOLD,
      listId: raw.listId ?? null,
    };
  } catch {
    return { view: 'household', householdCategories: DEFAULT_HOUSEHOLD, listId: null };
  }
}

function savePrefs(prefs) {
  try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* private mode: keep in memory */ }
}

/* ---------- page ---------- */

export async function render(container, context) {
  const { signal } = context;
  const state = {
    prefs: loadPrefs(),
    items: [],
    locations: [],
    categories: [],
    lists: null,
    lowOnly: false,
    query: '',
    open: new Set(),
    busy: new Set(),
    panel: null,        // null | 'add' | 'settings' | { edit: productKey }
    prompt: null,       // { key, amount } after crossing the minimum
    error: null,
  };

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({
      title: renderPageTitle(tx('title')),
      actions: renderPageActions(`
        <button type="button" class="btn btn--secondary" data-act="settings">${esc(tx('settings'))}</button>
        <button type="button" class="btn btn--primary" data-act="add">${esc(tx('add'))}</button>`),
    })
    + renderPageBody({ content: renderPageSection({ content: '<div class="hs" id="hs-root"></div>' }) }));
  const root = container.querySelector('#hs-root');

  async function load() {
    try {
      const res = await api.get('/pantry');
      if (signal.aborted) return;
      state.items = res.data ?? [];
      state.locations = res.locations ?? [];
      state.categories = res.categories ?? [];
      state.error = null;
    } catch (err) {
      if (signal.aborted) return;
      state.error = err?.status === 403 ? tx('noAccess') : (err?.data?.error ?? tx('loadError'));
    }
    draw();
  }

  const products = () => groupProducts(state.items);
  const findProduct = (key) => products().find((p) => p.key === key);

  /* ---------- drawing ---------- */

  function draw() {
    if (signal.aborted) return;
    root.replaceChildren();
    if (state.error) {
      root.insertAdjacentHTML('beforeend', `<p class="hs-empty">${esc(state.error)}</p>
        <button type="button" class="btn btn--secondary" data-act="reload">${esc(tx('retry'))}</button>`);
      return;
    }

    const visible = filterProducts(products(), {
      view: state.prefs.view,
      householdCategories: state.prefs.householdCategories,
      status: state.lowOnly ? 'low' : null,
      query: state.query,
    });

    root.insertAdjacentHTML('beforeend', `
      ${drawPrompt()}
      ${drawPanel()}
      <div class="hs-toolbar">
        <div class="hs-seg" role="group" aria-label="${esc(tx('view'))}">
          ${['household', 'food', 'all'].map((v) => `
            <button type="button" class="hs-seg__btn${state.prefs.view === v ? ' is-active' : ''}"
              data-act="view" data-view="${v}" aria-pressed="${state.prefs.view === v}">${esc(tx(`view_${v}`))}</button>`).join('')}
        </div>
        <button type="button" class="hs-chip${state.lowOnly ? ' is-active' : ''}" data-act="low" aria-pressed="${state.lowOnly}">
          ${esc(tx('lowOnly'))}
        </button>
        <input type="search" class="form-input hs-search" data-act="search" placeholder="${esc(tx('search'))}"
          value="${esc(state.query)}" aria-label="${esc(tx('search'))}">
      </div>
      ${visible.length ? `<ul class="hs-list">${visible.map(drawProduct).join('')}</ul>`
        : `<p class="hs-empty">${esc(state.items.length ? tx('emptyFiltered') : tx('empty'))}</p>`}
    `);
    window.lucide?.createIcons?.({ el: root });
    const search = root.querySelector('[data-act="search"]');
    if (search && state.focusSearch) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      state.focusSearch = false;
    }
  }

  function drawProduct(p) {
    const status = productStatus(p);
    const amount = restockAmount(p);
    const open = state.open.has(p.key);
    const busy = state.busy.has(p.key);
    const step = stepFor(p.unit);
    const meta = [
      p.min !== null ? tx('minShort', { n: fmt(p.min) }) : null,
      p.target !== null ? tx('targetShort', { n: fmt(p.target) }) : null,
      categoryLabel(p.category),
    ].filter(Boolean).join(' · ');
    const badge = status === 'ok' ? '' : `<span class="hs-badge hs-badge--${status}">${esc(tx(`status_${status}`))}</span>`;

    return `
      <li class="hs-item hs-item--${status}" data-key="${esc(p.key)}">
        <div class="hs-item__row">
          <button type="button" class="hs-item__main" data-act="toggle" aria-expanded="${open}">
            <span class="hs-item__name">${esc(p.name)} ${badge}</span>
            <span class="hs-item__meta">${esc(meta)}</span>
          </button>
          <div class="hs-stepper">
            <button type="button" class="hs-step" data-act="take" ${busy || p.total <= 0 ? 'disabled' : ''}
              aria-label="${esc(tx('takeOne', { name: p.name }))}">−</button>
            <span class="hs-qty">${esc(qtyLabel(p.total, p.unit))}</span>
            <button type="button" class="hs-step" data-act="put" ${busy ? 'disabled' : ''}
              aria-label="${esc(tx('putOne', { name: p.name }))}">+</button>
          </div>
        </div>
        ${open ? `
          <div class="hs-item__detail">
            <ul class="hs-batches">
              ${p.batches.map((b) => `
                <li class="hs-batch" data-batch="${b.id}">
                  <span class="hs-batch__where">${esc(b.location_name || tx('noLocation'))}</span>
                  ${b.expires_on ? `<span class="hs-batch__exp">${esc(tx('expires', { date: b.expires_on }))}</span>` : ''}
                  <span class="hs-stepper hs-stepper--small">
                    <button type="button" class="hs-step" data-act="batch-dec" data-step="${step}" ${busy || Number(b.quantity) <= 0 ? 'disabled' : ''}
                      aria-label="${esc(tx('takeOne', { name: b.location_name || p.name }))}">−</button>
                    <span class="hs-qty">${esc(qtyLabel(b.quantity, b.unit))}</span>
                    <button type="button" class="hs-step" data-act="batch-inc" data-step="${step}" ${busy ? 'disabled' : ''}
                      aria-label="${esc(tx('putOne', { name: b.location_name || p.name }))}">+</button>
                  </span>
                </li>`).join('')}
            </ul>
            <div class="hs-item__actions">
              ${amount > 0 ? `<button type="button" class="btn btn--primary" data-act="shop">${esc(tx('toShopping', { qty: qtyLabel(amount, p.unit) }))}</button>` : ''}
              <button type="button" class="btn btn--secondary" data-act="edit">${esc(tx('editLevels'))}</button>
              <button type="button" class="btn btn--secondary" data-act="add-batch">${esc(tx('addBatch'))}</button>
            </div>
          </div>` : ''}
      </li>`;
  }

  function drawPrompt() {
    if (!state.prompt) return '';
    const p = findProduct(state.prompt.key);
    if (!p) return '';
    return `
      <div class="hs-prompt" role="status">
        <p><strong>${esc(tx('promptTitle', { name: p.name }))}</strong><br>
        ${esc(tx('promptLeft', { qty: qtyLabel(p.total, p.unit) }))}<br>
        ${esc(tx('promptAsk', { amount: qtyLabel(state.prompt.amount, p.unit) }))}</p>
        <div class="hs-prompt__actions">
          <button type="button" class="btn btn--primary" data-act="prompt-yes" data-key="${esc(p.key)}">${esc(tx('promptYes'))}</button>
          <button type="button" class="btn btn--secondary" data-act="prompt-no">${esc(tx('promptNo'))}</button>
        </div>
      </div>`;
  }

  function drawPanel() {
    if (!state.panel) return '';
    if (state.panel === 'settings') {
      const names = state.categories.map((c) => c.name);
      return `
        <form class="hs-panel" data-form="settings">
          <h3 class="hs-panel__title">${esc(tx('settingsTitle'))}</h3>
          <p class="form-hint">${esc(tx('settingsHint'))}</p>
          <div class="hs-checks">
            ${names.map((n) => `
              <label class="hs-check">
                <input type="checkbox" name="cat" value="${esc(n)}" ${state.prefs.householdCategories.includes(n) ? 'checked' : ''}>
                ${esc(categoryLabel(n))}
              </label>`).join('')}
          </div>
          ${state.lists?.length > 1 ? `
            <div class="form-group">
              <label class="form-label" for="hs-list">${esc(tx('shoppingList'))}</label>
              <select class="form-input" id="hs-list" name="list">
                ${state.lists.map((l) => `<option value="${l.id}" ${l.id === state.prefs.listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
              </select>
            </div>` : ''}
          <div class="hs-panel__actions">
            <button type="submit" class="btn btn--primary">${esc(tx('save'))}</button>
            <button type="button" class="btn btn--secondary" data-act="close">${esc(tx('cancel'))}</button>
          </div>
        </form>`;
    }

    if (state.panel.edit) {
      const p = findProduct(state.panel.edit);
      if (!p) return '';
      return `
        <form class="hs-panel" data-form="levels" data-key="${esc(p.key)}">
          <h3 class="hs-panel__title">${esc(p.name)}</h3>
          <div class="hs-grid">
            ${numberField('min', tx('minimum'), p.min)}
            ${numberField('target', tx('target'), p.target)}
          </div>
          <p class="form-hint">${esc(tx('levelsHint'))}</p>
          <div class="hs-panel__actions">
            <button type="submit" class="btn btn--primary">${esc(tx('save'))}</button>
            <button type="button" class="btn btn--secondary" data-act="close">${esc(tx('cancel'))}</button>
          </div>
        </form>`;
    }

    // 'add' or { addTo: productKey }
    const base = state.panel.addTo ? findProduct(state.panel.addTo) : null;
    const defaultCat = base?.category
      ?? state.prefs.householdCategories.find((c) => state.categories.some((x) => x.name === c))
      ?? state.categories.at(-1)?.name;
    const existing = products().map((p) => p.name);
    return `
      <form class="hs-panel" data-form="add">
        <h3 class="hs-panel__title">${esc(base ? tx('addBatchTitle', { name: base.name }) : tx('addTitle'))}</h3>
        <div class="hs-grid">
          <div class="form-group hs-grid__wide">
            <label class="form-label" for="hs-name">${esc(tx('name'))}</label>
            <input class="form-input" id="hs-name" name="name" required maxlength="200" list="hs-names"
              value="${esc(base?.name ?? '')}" ${base ? 'readonly' : ''}>
            <datalist id="hs-names">${existing.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
          </div>
          ${numberField('quantity', tx('quantity'), 1, true)}
          <div class="form-group">
            <label class="form-label" for="hs-unit">${esc(tx('unit'))}</label>
            <select class="form-input" id="hs-unit" name="unit" ${base ? 'disabled' : ''}>
              ${PANTRY_UNITS.map((u) => `<option value="${u}" ${(base?.unit ?? 'pcs') === u ? 'selected' : ''}>${esc(t(`pantry.units.${u}`))}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="hs-loc">${esc(tx('location'))}</label>
            <select class="form-input" id="hs-loc" name="location_id">
              <option value="">${esc(tx('noLocation'))}</option>
              ${state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="hs-cat">${esc(tx('category'))}</label>
            <select class="form-input" id="hs-cat" name="category" ${base ? 'disabled' : ''}>
              ${state.categories.map((c) => `<option value="${esc(c.name)}" ${c.name === defaultCat ? 'selected' : ''}>${esc(categoryLabel(c.name))}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="hs-exp">${esc(tx('expiresOn'))}</label>
            <input class="form-input" id="hs-exp" name="expires_on" type="date">
          </div>
          ${base ? '' : numberField('min', tx('minimum'), null)}
          ${base ? '' : numberField('target', tx('target'), null)}
        </div>
        <div class="hs-panel__actions">
          <button type="submit" class="btn btn--primary">${esc(tx('save'))}</button>
          <button type="button" class="btn btn--secondary" data-act="close">${esc(tx('cancel'))}</button>
        </div>
      </form>`;
  }

  function numberField(name, label, value, required = false) {
    return `
      <div class="form-group">
        <label class="form-label" for="hs-${name}">${esc(label)}</label>
        <input class="form-input" id="hs-${name}" name="${name}" type="number" min="0" step="any" inputmode="decimal"
          value="${value === null || value === undefined ? '' : esc(String(value))}" ${required ? 'required' : ''}>
      </div>`;
  }

  /* ---------- actions ---------- */

  async function withBusy(key, fn) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    draw();
    try {
      await fn();
    } catch (err) {
      if (!signal.aborted) showToast(err?.data?.error ?? tx('saveError'), 'danger');
    } finally {
      state.busy.delete(key);
      await load();
    }
  }

  async function changeBatch(product, batch, delta) {
    const before = product.total;
    const next = roundQty(Number(batch.quantity) + delta);
    await api.patch(`/pantry/${batch.id}`, { quantity: next });
    const after = roundQty(before - Number(batch.quantity) + next);
    if (delta < 0 && crossedMinimum(before, after, product.min)) {
      const amount = restockAmount({ ...product, total: after });
      if (amount > 0) state.prompt = { key: product.key, amount };
    }
  }

  async function ensureLists() {
    if (state.lists) return state.lists;
    const res = await api.get('/shopping');
    state.lists = res.data ?? [];
    return state.lists;
  }

  async function sendToShopping(product, amount) {
    const lists = await ensureLists();
    if (!lists.length) {
      showToast(tx('noLists'), 'warning');
      return;
    }
    // The list chosen in the module settings, otherwise the first list.
    const list = lists.find((l) => l.id === state.prefs.listId) ?? lists[0];
    const res = await api.post(`/shopping/${list.id}/import-pantry`, {
      items: [{ pantry_item_id: product.primary.id, quantity: qtyLabel(amount, product.unit) }],
    });
    const added = res.data?.added ?? 0;
    showToast(added ? tx('addedToList', { name: product.name, list: list.name }) : tx('alreadyOnList'), added ? 'success' : 'info');
  }

  async function saveLevels(product, min, target) {
    const notes = writeMarker(product.primary.notes, { min, target });
    await api.patch(`/pantry/${product.primary.id}`, { notes });
    // A minimum stored on single batches by the core page would mark one batch
    // low on its own; the module owns the product minimum now, so clear those.
    for (const b of product.batches) {
      if (b.min_quantity !== null && b.min_quantity !== undefined) {
        await api.patch(`/pantry/${b.id}`, { min_quantity: null });
      }
    }
  }

  async function addItem(form) {
    const data = new FormData(form);
    const base = state.panel.addTo ? findProduct(state.panel.addTo) : null;
    const name = (base?.name ?? String(data.get('name') ?? '')).trim();
    if (!name) return;
    const unit = base?.unit ?? data.get('unit');
    const category = base?.category ?? data.get('category');
    const num = (v) => (v === null || v === '' ? null : roundQty(v));
    const existing = base ?? findProduct(productKey({ name, unit }));

    const body = {
      name: existing?.name ?? name,
      quantity: num(data.get('quantity')) ?? 1,
      unit,
      category: existing?.category ?? category,
      location_id: data.get('location_id') ? Number(data.get('location_id')) : null,
      expires_on: data.get('expires_on') || null,
    };
    const min = base ? undefined : num(data.get('min'));
    const target = base ? undefined : num(data.get('target'));
    if (!existing && (min !== null || target !== null)) body.notes = writeMarker(null, { min, target });

    await api.post('/pantry', body);
    if (existing && !base && (min !== null || target !== null)) {
      await saveLevels(existing, min ?? existing.min, target ?? existing.target);
    }
    showToast(tx('saved'), 'success');
  }

  /* ---------- events ---------- */

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !container.contains(btn)) return;
    const act = btn.dataset.act;
    const key = btn.closest('[data-key]')?.dataset.key;
    const product = key ? findProduct(key) : null;

    switch (act) {
      case 'add': state.panel = 'add'; draw(); root.querySelector('#hs-name')?.focus(); break;
      case 'settings':
        try { await ensureLists(); } catch { /* no shopping access: the list choice stays hidden */ }
        state.panel = 'settings';
        draw();
        break;
      case 'close': state.panel = null; draw(); break;
      case 'reload': load(); break;
      case 'view':
        state.prefs.view = btn.dataset.view;
        savePrefs(state.prefs);
        draw();
        break;
      case 'low': state.lowOnly = !state.lowOnly; draw(); break;
      case 'toggle':
        if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
        draw();
        break;
      case 'take': {
        if (!product) break;
        const batch = pickBatchForTake(product.batches);
        if (batch) await withBusy(key, () => changeBatch(product, batch, -stepFor(product.unit)));
        break;
      }
      case 'put': {
        if (!product) break;
        // "+1" goes to the batch "-1" would take from last: the largest one,
        // which is usually the storage (attic) rather than the one in use.
        const batch = [...product.batches].sort((a, b) => Number(b.quantity) - Number(a.quantity))[0];
        await withBusy(key, () => changeBatch(product, batch, stepFor(product.unit)));
        break;
      }
      case 'batch-dec':
      case 'batch-inc': {
        if (!product) break;
        const batch = product.batches.find((b) => String(b.id) === btn.closest('[data-batch]').dataset.batch);
        const step = Number(btn.dataset.step) || 1;
        if (batch) await withBusy(key, () => changeBatch(product, batch, act === 'batch-dec' ? -step : step));
        break;
      }
      case 'shop':
        if (product) await withBusy(key, () => sendToShopping(product, restockAmount(product)));
        break;
      case 'edit': state.panel = { edit: key }; draw(); break;
      case 'add-batch': state.panel = { addTo: key }; draw(); break;
      case 'prompt-yes': {
        const target = findProduct(btn.dataset.key);
        const amount = state.prompt?.amount;
        state.prompt = null;
        if (target && amount) await withBusy(target.key, () => sendToShopping(target, amount));
        else draw();
        break;
      }
      case 'prompt-no': state.prompt = null; draw(); break;
      default: break;
    }
  }, { signal });

  container.addEventListener('input', (e) => {
    if (e.target.dataset?.act !== 'search') return;
    state.query = e.target.value;
    state.focusSearch = true;
    draw();
  }, { signal });

  container.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (form.dataset.form === 'settings') {
        state.prefs.householdCategories = [...form.querySelectorAll('input[name="cat"]:checked')].map((i) => i.value);
        const listSelect = form.querySelector('select[name="list"]');
        if (listSelect) state.prefs.listId = Number(listSelect.value);
        savePrefs(state.prefs);
        state.panel = null;
        draw();
        return;
      }
      if (form.dataset.form === 'levels') {
        const product = findProduct(form.dataset.key);
        const data = new FormData(form);
        const num = (v) => (v === null || v === '' ? null : roundQty(v));
        if (product) await saveLevels(product, num(data.get('min')), num(data.get('target')));
        showToast(tx('saved'), 'success');
      } else {
        await addItem(form);
      }
      state.panel = null;
      await load();
    } catch (err) {
      if (!signal.aborted) showToast(err?.data?.error ?? tx('saveError'), 'danger');
      if (submit) submit.disabled = false;
    }
  }, { signal });

  root.insertAdjacentHTML('beforeend', `<p class="hs-empty">${esc(tx('loading'))}</p>`);
  await load();
}

