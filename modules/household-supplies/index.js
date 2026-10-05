/**
 * Household supplies - a Yuvomi third-party module.
 *
 * A separate page for household consumables (toothpaste, toilet paper,
 * dishwasher tablets...). It stores nothing of its own: every item is a normal
 * row in Yuvomi's pantry, so the data is shared with the household and shows up
 * in the core pantry page too. Rules live in logic.js, markup in view.js, the
 * API calls in actions.js; this file holds the state and the event handlers.
 */

import { api } from '/api.js';
import { t, getNumberFormat, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { showToast } from '/utils/toast-show.js';
import { mayTransferPantryToShopping } from '/utils/kitchen-transfer.js';
import { moduleAccess } from '/permissions.js';
import { categoryLabel } from '/utils/shopping-categories.js';
import { PANTRY_UNITS, pantryQuantityLabel } from '/utils/pantry-units.js';
import { renderPageHeader, renderPageTitle, renderPageActions, renderPageBody, renderPageSection } from '/utils/page-layout.js';
import { todayKey } from '/utils/date.js';
import { groupProducts, restockAmount, pickBatchForTake, pickBatchForPut, stepFor } from './logic.js';
import { renderBody, nameHint, focusSelector } from './view.js';
import { createActions } from './actions.js';

const ID = 'household-supplies';
const STORE = `yuvomi-ext:${ID}`;
const DEFAULT_HOUSEHOLD = ['Haushalt', 'Drogerie'];

const tx = (key, params) => t(`extensions.${ID}.${key}`, params);
const fmt = (n) => getNumberFormat({ maximumFractionDigits: 2 }).format(n);
const qtyLabel = (n, unit) => pantryQuantityLabel(n, unit, { t, formatNumber: fmt });

/* ---------- per-person preferences (this device) ---------- */

function loadPrefs() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* blocked or corrupt storage: defaults */ }
  return {
    view: ['household', 'food', 'all'].includes(raw.view) ? raw.view : 'household',
    householdCategories: Array.isArray(raw.householdCategories) ? raw.householdCategories : DEFAULT_HOUSEHOLD,
    listId: raw.listId ?? null,
  };
}

function savePrefs(prefs) {
  try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* private mode: keep in memory */ }
}

/* ---------- page ---------- */

export async function render(container, { signal }) {
  const canWrite = moduleAccess('pantry') === 'write';
  const ctx = {
    tx, t, esc, fmt, qtyLabel, categoryLabel, formatDate, units: PANTRY_UNITS,
    canWrite, canShop: mayTransferPantryToShopping(), today: todayKey(),
  };
  const state = {
    prefs: loadPrefs(), items: [], locations: [], categories: [], lists: null,
    lowOnly: false, query: '', open: new Set(), busy: new Set(),
    panel: null,        // null | 'add' | 'settings' | { edit: key } | { addTo: key }
    prompt: null,       // { key, amount } after crossing the minimum
    lastBatch: {},      // product key -> batch id the last "-1" took from
    draftName: '',      // the name typed into "New item"
    focusSearch: false, focusPanel: false, lastFocusSel: null, error: null,
  };

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend',
    renderPageHeader({
      title: renderPageTitle(tx('title')),
      actions: renderPageActions(`
        <button type="button" class="btn btn--secondary" data-act="settings">${esc(tx('settings'))}</button>
        ${canWrite ? `<button type="button" class="btn btn--primary" data-act="add">${esc(tx('add'))}</button>` : ''}`),
    })
    + renderPageBody({ content: renderPageSection({ content: '<div class="hs" id="hs-root"></div><div class="sr-only" aria-live="polite" id="hs-status"></div>' }) }));
  const root = container.querySelector('#hs-root');
  const status = container.querySelector('#hs-status');

  const products = () => groupProducts(state.items);
  const findProduct = (key) => products().find((p) => p.key === key);
  const announce = (text) => { status.textContent = text; };
  const toast = (...args) => { if (!signal.aborted) showToast(...args); };

  // The selector of the control that has focus right now, or null.
  function currentFocusSel() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    return focusSelector({
      act: active.dataset.act, view: active.dataset.view,
      key: active.closest('[data-key]')?.dataset.key, batch: active.closest('[data-batch]')?.dataset.batch,
    }, CSS.escape) || null;
  }

  function draw() {
    if (signal.aborted) return;
    // Remember which control had focus so a re-render does not drop it. While a
    // request is in flight the control is rendered disabled and cannot take
    // focus, so withBusy() parks the selector in state.lastFocusSel and the
    // draw after the request puts focus back.
    const sel = currentFocusSel() || state.lastFocusSel;
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', renderBody(state, ctx));
    if (sel) {
      const el = root.querySelector(sel);
      if (el && !el.disabled) el.focus();
    }
    const search = root.querySelector('[data-act="search"]');
    if (search && state.focusSearch) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      state.focusSearch = false;
    }
    const panel = root.querySelector('.hs-panel');
    if (panel && state.focusPanel) {
      panel.scrollIntoView({ block: 'start' });
      panel.querySelector('input:not([readonly]), select')?.focus();
      state.focusPanel = false;
    }
  }

  function openPanel(panel) { state.panel = panel; state.focusPanel = true; draw(); }

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

  // One request per product at a time; steppers apply the response, the
  // shopping hand-over reloads the list.
  async function withBusy(key, fn, { reload = false } = {}) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    state.lastFocusSel = currentFocusSel();
    draw();
    try {
      await fn();
    } catch (err) {
      toast(err?.data?.error ?? tx('saveError'), 'danger');
    } finally {
      state.busy.delete(key);
      if (!signal.aborted) { if (reload) await load(); else draw(); }
      state.lastFocusSel = null;
    }
  }

  const actions = createActions({ state, signal, tx, qtyLabel, products, announce, toast, withBusy });

  /* ---------- events ---------- */

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !container.contains(btn)) return;
    const act = btn.dataset.act;
    const key = btn.closest('[data-key]')?.dataset.key;
    const product = key ? findProduct(key) : null;
    const change = (batch, delta) => batch && withBusy(key, () => actions.changeBatch(product, batch, delta));

    switch (act) {
      case 'add': state.draftName = ''; openPanel('add'); break;
      case 'settings':
        try { await actions.ensureLists(); } catch { /* no shopping access: the list choice stays hidden */ }
        if (!signal.aborted) openPanel('settings');
        break;
      case 'close': state.panel = null; draw(); break;
      case 'reload': load(); break;
      case 'view': state.prefs.view = btn.dataset.view; savePrefs(state.prefs); draw(); break;
      case 'low': state.lowOnly = !state.lowOnly; draw(); break;
      case 'toggle':
        if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
        draw();
        break;
      case 'take': if (product) await change(pickBatchForTake(product.batches), -stepFor(product.unit)); break;
      case 'put': if (product) await change(pickBatchForPut(product.batches, state.lastBatch[key]), stepFor(product.unit)); break;
      case 'batch-dec':
      case 'batch-inc': {
        if (!product) break;
        const batch = product.batches.find((b) => String(b.id) === btn.closest('[data-batch]')?.dataset.batch);
        const step = Number(btn.dataset.step) || 1;
        await change(batch, act === 'batch-dec' ? -step : step);
        break;
      }
      case 'shop':
        if (product) await withBusy(key, () => actions.sendToShopping(product, restockAmount(product)), { reload: true });
        break;
      case 'edit': openPanel({ edit: key }); break;
      case 'add-batch': openPanel({ addTo: key }); break;
      case 'prompt-yes': {
        const amount = state.prompt?.amount;
        state.prompt = null;
        if (product && amount) await withBusy(key, () => actions.sendToShopping(product, amount), { reload: true });
        else draw();
        break;
      }
      case 'prompt-no': state.prompt = null; draw(); break;
      default: break;
    }
  }, { signal });

  container.addEventListener('input', (e) => {
    if (e.target.dataset?.act === 'search') {
      state.query = e.target.value;
      state.focusSearch = true;
      draw();
    } else if (e.target.id === 'hs-name') {
      state.draftName = e.target.value;
      const hint = root.querySelector('#hs-name-hint');
      if (hint) { hint.textContent = nameHint(state.draftName, products(), ctx); hint.hidden = !hint.textContent; }
    }
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
      if (form.dataset.form === 'levels') await actions.saveLevelsForm(form);
      else await actions.addItem(form);
      if (signal.aborted) return;
      toast(tx('saved'), 'success');
      state.panel = null;
      await load();
    } catch (err) {
      toast(err?.data?.error ?? tx('saveError'), 'danger');
      if (submit) submit.disabled = false;
    }
  }, { signal });

  root.insertAdjacentHTML('beforeend', `<p class="hs-empty">${esc(tx('loading'))}</p>`);
  await load();
}
