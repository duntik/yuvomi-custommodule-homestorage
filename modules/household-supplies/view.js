/**
 * Household supplies: HTML string renderers. Pure functions of (state, ctx),
 * no DOM and no imports from Yuvomi, so they run under node:test.
 *
 * ctx carries everything that comes from the host:
 *   tx(key, params)      module translation
 *   t(key, params)       core translation (unit names)
 *   esc(text)            HTML escape
 *   fmt(n)               number in the user's locale
 *   qtyLabel(n, unit)    "3 pcs" with the unit inflected
 *   categoryLabel(name)  translated name of a default category
 *   formatDate(key)      "YYYY-MM-DD" in the user's date format
 *   units                PANTRY_UNITS
 *   canWrite             pantry write access
 *   canShop              may transfer pantry rows to the shopping list
 *   today                today's date key in the household's time zone
 */

import {
  groupProducts, productStatus, restockAmount, stepFor, filterProducts,
  expiryStatus, findByName,
} from './logic.js';

/** The id of a product's detail element, for aria-controls. */
export function detailId(key) {
  return `hs-detail-${String(key).replace(/[^a-z0-9]+/gi, '-')}`;
}

/**
 * The selector that finds the same control again after a re-render, from the
 * data-* attributes of the control that had focus. `escape` is CSS.escape.
 */
export function focusSelector({ act, view, key, batch }, escape) {
  if (!act) return null;
  return (key ? `[data-key="${escape(key)}"] ` : '')
    + (batch ? `[data-batch="${escape(batch)}"] ` : '')
    + `[data-act="${escape(act)}"]`
    + (view ? `[data-view="${escape(view)}"]` : '');
}

function expiryBadge(status, ctx) {
  if (!status) return '';
  return `<span class="hs-badge hs-badge--${status === 'expired' ? 'empty' : 'low'}">${ctx.esc(ctx.tx(status === 'expired' ? 'expired' : 'expiresSoon'))}</span>`;
}

/** Worst expiry over all batches: 'expired' beats 'soon'. */
function productExpiry(product, ctx) {
  let worst = null;
  for (const b of product.batches) {
    const s = expiryStatus(b.expires_on, ctx.today);
    if (s === 'expired') return 'expired';
    if (s === 'soon') worst = 'soon';
  }
  return worst;
}

export function renderPrompt(product, state, ctx) {
  const { tx, esc, qtyLabel } = ctx;
  if (!state.prompt || state.prompt.key !== product.key) return '';
  return `
    <div class="hs-prompt" role="status">
      <p><strong>${esc(tx('promptTitle', { name: product.name }))}</strong><br>
      ${esc(tx('promptLeft', { qty: qtyLabel(product.total, product.unit) }))}<br>
      ${esc(tx('promptAsk', { amount: qtyLabel(state.prompt.amount, product.unit) }))}</p>
      <div class="hs-prompt__actions">
        ${ctx.canShop ? `<button type="button" class="btn btn--primary" data-act="prompt-yes">${esc(tx('promptYes'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-act="prompt-no">${esc(tx('promptNo'))}</button>
      </div>
    </div>`;
}

function renderBatch(b, product, busy, ctx) {
  const { tx, esc, qtyLabel, formatDate } = ctx;
  const step = stepFor(product.unit);
  const where = b.location_name || tx('noLocation');
  return `
    <li class="hs-batch" data-batch="${b.id}">
      <span class="hs-batch__where">${esc(where)}</span>
      ${b.expires_on ? `<span class="hs-batch__exp">${esc(tx('expires', { date: formatDate(b.expires_on) }))}</span>` : ''}
      ${expiryBadge(expiryStatus(b.expires_on, ctx.today), ctx)}
      ${ctx.canWrite ? `
        <span class="hs-stepper hs-stepper--small">
          <button type="button" class="hs-step" data-act="batch-dec" data-step="${step}" ${busy || Number(b.quantity) <= 0 ? 'disabled' : ''}
            aria-label="${esc(tx('takeOne', { name: where }))}">−</button>
          <span class="hs-qty">${esc(qtyLabel(b.quantity, b.unit))}</span>
          <button type="button" class="hs-step" data-act="batch-inc" data-step="${step}" ${busy ? 'disabled' : ''}
            aria-label="${esc(tx('putOne', { name: where }))}">+</button>
        </span>`
    : `<span class="hs-qty">${esc(qtyLabel(b.quantity, b.unit))}</span>`}
    </li>`;
}

export function renderProduct(p, state, ctx) {
  const { tx, esc, fmt, qtyLabel, categoryLabel } = ctx;
  const status = productStatus(p);
  const amount = restockAmount(p);
  const open = state.open.has(p.key);
  const busy = state.busy.has(p.key);
  const meta = [
    p.min !== null ? tx('minShort', { n: fmt(p.min) }) : null,
    p.target !== null ? tx('targetShort', { n: fmt(p.target) }) : null,
    categoryLabel(p.category),
  ].filter(Boolean).join(' · ');
  const badge = status === 'ok' ? '' : `<span class="hs-badge hs-badge--${status}">${esc(tx(`status_${status}`))}</span>`;
  const id = detailId(p.key);

  return `
    <li class="hs-item" data-key="${esc(p.key)}">
      <div class="hs-item__row">
        <button type="button" class="hs-item__main" data-act="toggle" aria-expanded="${open}" aria-controls="${id}">
          <span class="hs-item__name">${esc(p.name)} ${badge}${expiryBadge(productExpiry(p, ctx), ctx)}</span>
          <span class="hs-item__meta">${esc(meta)}</span>
        </button>
        ${ctx.canWrite ? `
        <div class="hs-stepper">
          <button type="button" class="hs-step" data-act="take" ${busy || p.total <= 0 ? 'disabled' : ''}
            aria-label="${esc(tx('takeOne', { name: p.name }))}">−</button>
          <span class="hs-qty">${esc(qtyLabel(p.total, p.unit))}</span>
          <button type="button" class="hs-step" data-act="put" ${busy ? 'disabled' : ''}
            aria-label="${esc(tx('putOne', { name: p.name }))}">+</button>
        </div>`
      : `<span class="hs-qty">${esc(qtyLabel(p.total, p.unit))}</span>`}
      </div>
      ${renderPrompt(p, state, ctx)}
      <div class="hs-item__detail" id="${id}" ${open ? '' : 'hidden'}>
        ${open ? `
        <ul class="hs-batches">${p.batches.map((b) => renderBatch(b, p, busy, ctx)).join('')}</ul>
        <div class="hs-item__actions">
          ${ctx.canShop && amount > 0 ? `<button type="button" class="btn btn--primary" data-act="shop">${esc(tx('toShopping', { qty: qtyLabel(amount, p.unit) }))}</button>` : ''}
          ${ctx.canWrite ? `
          <button type="button" class="btn btn--secondary" data-act="edit">${esc(tx('editLevels'))}</button>
          <button type="button" class="btn btn--secondary" data-act="add-batch">${esc(tx('addBatch'))}</button>` : ''}
        </div>` : ''}
      </div>
    </li>`;
}

function numberField(name, label, value, ctx, required = false) {
  return `
    <div class="form-group">
      <label class="form-label" for="hs-${name}">${ctx.esc(label)}</label>
      <input class="form-input" id="hs-${name}" name="${name}" type="number" min="0" step="any" inputmode="decimal"
        value="${value === null || value === undefined ? '' : ctx.esc(String(value))}" ${required ? 'required' : ''}>
    </div>`;
}

/** Unit <option>s; a unit without a core locale key shows its raw code. */
export function renderUnitOptions(selected, ctx) {
  return ctx.units.map((u) => {
    const key = `pantry.units.${u}`;
    const label = ctx.t(key);
    return `<option value="${u}" ${selected === u ? 'selected' : ''}>${ctx.esc(label === key ? u : label)}</option>`;
  }).join('');
}

/** The one-line hint under "Name" when the typed name already exists, else ''. */
export function nameHint(name, products, ctx) {
  const existing = findByName(products, name);
  if (!existing) return '';
  const unitKey = `pantry.units.${existing.unit}`;
  const unit = ctx.t(unitKey);
  return ctx.tx('joinsExisting', {
    name: existing.name,
    unit: unit === unitKey ? existing.unit : unit,
    category: ctx.categoryLabel(existing.category),
  });
}

function renderSettings(state, ctx) {
  const { tx, esc, categoryLabel } = ctx;
  const names = state.categories.map((c) => c.name);
  return `
    <form class="hs-panel" data-form="settings">
      <h2 class="hs-panel__title">${esc(tx('settingsTitle'))}</h2>
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

function renderLevels(p, ctx) {
  const { tx, esc } = ctx;
  return `
    <form class="hs-panel" data-form="levels" data-key="${esc(p.key)}">
      <h2 class="hs-panel__title">${esc(p.name)}</h2>
      <div class="hs-grid">
        ${numberField('min', tx('minimum'), p.min, ctx)}
        ${numberField('target', tx('target'), p.target, ctx)}
      </div>
      <p class="form-hint">${esc(tx('levelsHint'))}</p>
      <div class="hs-panel__actions">
        <button type="submit" class="btn btn--primary">${esc(tx('save'))}</button>
        <button type="button" class="btn btn--secondary" data-act="close">${esc(tx('cancel'))}</button>
      </div>
    </form>`;
}

function renderAdd(state, ctx, products, base) {
  const { tx, esc, categoryLabel } = ctx;
  const defaultCat = base?.category
    ?? state.prefs.householdCategories.find((c) => state.categories.some((x) => x.name === c))
    ?? state.categories.at(-1)?.name;
  const hint = base ? '' : nameHint(state.draftName, products, ctx);
  return `
    <form class="hs-panel" data-form="add">
      <h2 class="hs-panel__title">${esc(base ? tx('addBatchTitle', { name: base.name }) : tx('addTitle'))}</h2>
      <div class="hs-grid">
        <div class="form-group hs-grid__wide">
          <label class="form-label" for="hs-name">${esc(tx('name'))}</label>
          <input class="form-input" id="hs-name" name="name" required maxlength="200" list="hs-names"
            value="${esc(base?.name ?? state.draftName ?? '')}" ${base ? 'readonly' : 'aria-describedby="hs-name-hint"'}>
          <datalist id="hs-names">${products.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
          ${base ? '' : `<p class="form-hint hs-hint" id="hs-name-hint" ${hint ? '' : 'hidden'}>${esc(hint)}</p>`}
        </div>
        ${numberField('quantity', tx('quantity'), 1, ctx, true)}
        <div class="form-group">
          <label class="form-label" for="hs-unit">${esc(tx('unit'))}</label>
          <select class="form-input" id="hs-unit" name="unit" ${base ? 'disabled' : ''}>
            ${renderUnitOptions(base?.unit ?? 'pcs', ctx)}
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
        ${base ? '' : numberField('min', tx('minimum'), null, ctx)}
        ${base ? '' : numberField('target', tx('target'), null, ctx)}
      </div>
      <div class="hs-panel__actions">
        <button type="submit" class="btn btn--primary">${esc(tx('save'))}</button>
        <button type="button" class="btn btn--secondary" data-act="close">${esc(tx('cancel'))}</button>
      </div>
    </form>`;
}

/** The open panel (add, add batch, levels, settings) or ''. */
export function renderPanel(state, ctx) {
  if (!state.panel) return '';
  if (state.panel === 'settings') return renderSettings(state, ctx);
  const products = groupProducts(state.items);
  if (state.panel.edit) {
    const p = products.find((x) => x.key === state.panel.edit);
    return p ? renderLevels(p, ctx) : '';
  }
  const base = state.panel.addTo ? products.find((x) => x.key === state.panel.addTo) : null;
  if (state.panel.addTo && !base) return '';
  return renderAdd(state, ctx, products, base);
}

function renderToolbar(state, ctx, lowCount) {
  const { tx, esc } = ctx;
  return `
    <div class="hs-toolbar">
      <div class="hs-seg" role="group" aria-label="${esc(tx('view'))}">
        ${['household', 'food', 'all'].map((v) => `
          <button type="button" class="hs-seg__btn${state.prefs.view === v ? ' is-active' : ''}"
            data-act="view" data-view="${v}" aria-pressed="${state.prefs.view === v}">${esc(tx(`view_${v}`))}</button>`).join('')}
      </div>
      <button type="button" class="hs-chip${state.lowOnly ? ' is-active' : ''}" data-act="low" aria-pressed="${state.lowOnly}">
        ${esc(tx('lowOnly'))}${lowCount ? `<span class="hs-chip__count">${lowCount}</span>` : ''}
      </button>
      <input type="search" class="form-input hs-search" data-act="search" placeholder="${esc(tx('search'))}"
        value="${esc(state.query)}" aria-label="${esc(tx('search'))}">
    </div>`;
}

/** Everything inside the module root: error, panel, toolbar and the list. */
export function renderBody(state, ctx) {
  const { tx, esc } = ctx;
  if (state.error) {
    return `<p class="hs-empty">${esc(state.error)}</p>
      <button type="button" class="btn btn--secondary" data-act="reload">${esc(tx('retry'))}</button>`;
  }
  const products = groupProducts(state.items);
  const scope = { view: state.prefs.view, householdCategories: state.prefs.householdCategories };
  const visible = filterProducts(products, { ...scope, status: state.lowOnly ? 'low' : null, query: state.query });
  const lowCount = filterProducts(products, { ...scope, status: 'low' }).length;
  return `
    ${renderPanel(state, ctx)}
    ${renderToolbar(state, ctx, lowCount)}
    ${visible.length
    ? `<ul class="hs-list">${visible.map((p) => renderProduct(p, state, ctx)).join('')}</ul>`
    : `<p class="hs-empty">${esc(state.items.length ? tx('emptyFiltered') : tx('empty'))}</p>`}`;
}
