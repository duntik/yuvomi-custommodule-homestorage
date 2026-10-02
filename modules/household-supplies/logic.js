/**
 * Household supplies: pure logic, no DOM and no network.
 *
 * Data lives in Yuvomi's own pantry (`/api/v1/pantry`): one pantry row is one
 * batch (quantity, location, expiry). This module groups batches that share a
 * name and unit into one product and keeps the product-level settings
 * (minimum, target) in a small marker at the end of the notes of one batch:
 *
 *   "bought in bulk [stock min=3 target=12]"
 *
 * Nothing outside the pantry API is stored, so the data stays with Yuvomi,
 * is shared with the whole household and survives removing the module.
 */

const MARKER_RE = /\s*\[stock\b([^\]]*)\]\s*$/;

/** Round like Yuvomi's pantry does: two decimals, never negative. */
export function roundQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.round(v * 100) / 100);
}

function parseNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? roundQty(v) : null;
}

/** Split notes into the user's own text and the module's marker values. */
export function parseMarker(notes) {
  const text = typeof notes === 'string' ? notes : '';
  const match = text.match(MARKER_RE);
  if (!match) return { rest: text, min: null, target: null, hasMarker: false };
  const values = {};
  for (const pair of match[1].trim().split(/\s+/)) {
    const [key, value] = pair.split('=');
    if (key === 'min' || key === 'target') values[key] = parseNumber(value);
  }
  return {
    rest: text.slice(0, match.index),
    min: values.min ?? null,
    target: values.target ?? null,
    hasMarker: true,
  };
}

/** Write the marker back, keeping the user's own text untouched. */
export function writeMarker(notes, { min = null, target = null } = {}) {
  const { rest } = parseMarker(notes);
  const parts = [];
  if (min !== null && min !== undefined && min !== '') parts.push(`min=${roundQty(min)}`);
  if (target !== null && target !== undefined && target !== '') parts.push(`target=${roundQty(target)}`);
  const base = rest.trimEnd();
  if (!parts.length) return base || null;
  const marker = `[stock ${parts.join(' ')}]`;
  return base ? `${base} ${marker}` : marker;
}

/**
 * Batches belong to the same product when name (case-insensitive) and unit match.
 * The key ends up in a data-* attribute, so it must be plain printable text:
 * the unit comes first because it is from a fixed list and never contains "|".
 */
export function productKey(item) {
  return `${item.unit ?? ''}|${String(item.name ?? '').trim().toLocaleLowerCase()}`;
}

/**
 * Group pantry rows into products.
 *
 * The minimum comes from the marker if one is set, otherwise from the largest
 * `min_quantity` Yuvomi itself stores on a batch, so a minimum entered in the
 * core pantry page is honoured too. The minimum is compared against the SUM of
 * all batches: 1 in the bathroom plus 8 in the attic with a minimum of 3 is
 * not low.
 */
export function groupProducts(items) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const key = productKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }

  const products = [];
  for (const [key, batches] of byKey) {
    batches.sort((a, b) => a.id - b.id);
    const marked = batches.find((b) => parseMarker(b.notes).hasMarker);
    const primary = marked ?? batches[0];
    const marker = parseMarker(primary.notes);
    const coreMins = batches.map((b) => b.min_quantity).filter((v) => v !== null && v !== undefined);
    const min = marker.min ?? (coreMins.length ? roundQty(Math.max(...coreMins.map(Number))) : null);
    const total = roundQty(batches.reduce((sum, b) => sum + Number(b.quantity || 0), 0));
    products.push({
      key,
      name: String(primary.name ?? '').trim(),
      unit: primary.unit,
      category: primary.category,
      batches,
      primary,
      total,
      min,
      target: marker.target,
    });
  }
  return products.sort((a, b) => a.name.localeCompare(b.name));
}

/** 'empty' | 'low' | 'ok' */
export function productStatus(product) {
  if (product.total <= 0) return 'empty';
  if (product.min !== null && product.total <= product.min) return 'low';
  return 'ok';
}

/**
 * How much to buy: up to the target when one is set, otherwise up to the
 * minimum. This is the "Target 12, current 3, buy 9" rule from discussion #1077.
 */
export function restockAmount(product) {
  const goal = product.target ?? product.min;
  if (goal === null || goal === undefined) return 0;
  return roundQty(goal - product.total);
}

/** True when a change moved the product from above its minimum to at or below it. */
export function crossedMinimum(before, after, min) {
  if (min === null || min === undefined) return false;
  return before > min && after <= min;
}

/**
 * Which batch a product-level "-1" takes from: the one that expires first,
 * then the smallest, then the oldest. Batches already at zero are skipped.
 */
export function pickBatchForTake(batches) {
  const candidates = (batches ?? []).filter((b) => Number(b.quantity) > 0);
  candidates.sort((a, b) => {
    const ea = a.expires_on ?? '9999-12-31';
    const eb = b.expires_on ?? '9999-12-31';
    if (ea !== eb) return ea < eb ? -1 : 1;
    if (Number(a.quantity) !== Number(b.quantity)) return Number(a.quantity) - Number(b.quantity);
    return a.id - b.id;
  });
  return candidates[0] ?? null;
}

/** Step size per unit, matching Yuvomi's pantry stepper. */
export function stepFor(unit) {
  if (unit === 'g' || unit === 'ml') return 100;
  if (unit === 'kg' || unit === 'l') return 0.5;
  return 1;
}

/** Filter products by view ('household' | 'food' | 'all') and status ('low' | null). */
export function filterProducts(products, { view = 'household', householdCategories = [], status = null, query = '' } = {}) {
  const household = new Set(householdCategories);
  const q = query.trim().toLocaleLowerCase();
  return products.filter((p) => {
    if (view === 'household' && !household.has(p.category)) return false;
    if (view === 'food' && household.has(p.category)) return false;
    if (status === 'low' && productStatus(p) === 'ok') return false;
    if (q && !p.name.toLocaleLowerCase().includes(q)) return false;
    return true;
  });
}
