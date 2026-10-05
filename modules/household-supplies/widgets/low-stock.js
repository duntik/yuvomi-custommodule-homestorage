/**
 * Dashboard widget "Running low": the products at or below their minimum,
 * with a "-1" per row for members who may write to the pantry. The module's
 * stylesheet is not loaded on the dashboard, so the markup uses only core
 * classes (widget chrome, list rows, row actions).
 */

import { api } from '/api.js';
import { t, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { moduleAccess } from '/permissions.js';
import { pantryQuantityLabel } from '/utils/pantry-units.js';
import {
  groupProducts, filterProducts, pickBatchForTake, stepFor, applyDelta, mergeItem, parseCategoryList,
} from '../logic.js';

const ID = 'household-supplies';
const ACCENT = '#0EA5E9';
const DEFAULT_HOUSEHOLD = ['Haushalt', 'Drogerie'];

const tx = (key, params) => t(`extensions.${ID}.${key}`, params);
const fmt = (n) => getNumberFormat({ maximumFractionDigits: 2 }).format(n);
const qtyLabel = (n, unit) => pantryQuantityLabel(n, unit, { t, formatNumber: fmt });

/** Rows per tile: 1xN shows 4, 2xN and wider show 8. */
export function rowCap(size) {
  return Number(String(size ?? '1x2').split('x')[0]) >= 2 ? 8 : 4;
}

function header(count) {
  const title = esc(tx('widget.title'));
  const badge = count > 0 ? `<span aria-hidden="true" class="widget__badge">${count}</span>` : '';
  const countText = count > 0 ? `<span class="sr-only">${esc(tx('widget.count', { count }))}</span>` : '';
  return `
    <div class="widget__header">
      <h3 class="widget__title">
        <span class="module-seal module-seal--sm" style="--seal-accent: ${ACCENT}" aria-hidden="true">
          <i data-lucide="package" aria-hidden="true"></i>
        </span>
        <span class="widget__title-text">${title}</span>
        ${badge}
      </h3>
      ${countText}
      <a href="/m/${ID}" data-route="/m/${ID}" class="widget__link" aria-label="${esc(tx('widget.all'))}: ${title}">${esc(tx('widget.all'))}</a>
    </div>`;
}

function row(p, canWrite) {
  return `
    <div class="list-row" data-key="${esc(p.key)}">
      <div class="list-row__main">
        <div class="list-row__name">${esc(p.name)}</div>
        <div class="list-row__meta">${esc(qtyLabel(p.total, p.unit))}</div>
      </div>
      ${canWrite ? `
      <div class="list-row__actions">
        <button type="button" class="row-action" data-act="take" ${p.total <= 0 ? 'disabled' : ''}
          aria-label="${esc(tx('takeOne', { name: p.name }))}"><i data-lucide="circle-minus" aria-hidden="true"></i></button>
      </div>` : ''}
    </div>`;
}

export async function renderWidget(container, { size, options } = {}) {
  const view = ['household', 'food', 'all'].includes(options?.view) ? options.view : 'household';
  const householdCategories = parseCategoryList(options?.household_categories, DEFAULT_HOUSEHOLD);
  const canWrite = moduleAccess('pantry') === 'write';
  const cap = rowCap(size);

  // Errors propagate: the dashboard renders its own error chrome for the tile.
  const res = await api.get('/pantry');
  let items = res.data ?? [];

  const low = () => filterProducts(groupProducts(items), { view, householdCategories, status: 'low' });

  function draw() {
    const products = low();
    const body = products.length
      ? `<div class="widget__body row-divided">${products.slice(0, cap).map((p) => row(p, canWrite)).join('')}</div>`
      : `<div class="widget__empty"><i data-lucide="package-check" class="empty-state__icon" aria-hidden="true"></i><div>${esc(tx('widget.empty'))}</div></div>`;
    container.replaceChildren();
    container.insertAdjacentHTML('beforeend', header(products.length) + body);
    window.lucide?.createIcons?.({ el: container });
  }

  if (canWrite && !container.dataset.hsWired) {
    container.dataset.hsWired = '1';
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act="take"]');
      if (!btn || !container.contains(btn)) return;
      const key = btn.closest('[data-key]')?.dataset.key;
      const product = low().find((p) => p.key === key);
      const batch = product && pickBatchForTake(product.batches);
      if (!batch) return;
      btn.disabled = true;
      try {
        const { next } = applyDelta(product, batch, -stepFor(product.unit));
        const out = await api.patch(`/pantry/${batch.id}`, { quantity: next });
        items = mergeItem(items, out.data ?? { ...batch, quantity: next });
        navigator.vibrate?.(8);
        draw();
      } catch (err) {
        btn.disabled = false;
        window.yuvomi?.showToast?.(err?.data?.error ?? tx('saveError'), 'danger');
      }
    });
  }

  draw();
}
