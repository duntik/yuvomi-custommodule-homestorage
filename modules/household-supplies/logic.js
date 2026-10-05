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

/** Yuvomi's limit for a pantry note (server/middleware/validate.js MAX_TEXT). */
export const MAX_TEXT = 5000;

/** A batch counts as "expires soon" this many days ahead, like the core pantry. */
export const EXPIRY_SOON_DAYS = 7;

// A marker needs at least one key=value pair: "[stock]" or "[stock foo]" in a
// user's own text is just text. The marker has to be the last thing in the note.
const MARKER_RE = /\s*\[stock((?:\s+\w+=[^\s\]]*)+)\s*\]\s*$/;

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

/**
 * Write the marker back, keeping the user's own text untouched. The result
 * never exceeds MAX_TEXT: the user text is trimmed before the marker is lost.
 */
export function writeMarker(notes, { min = null, target = null } = {}) {
  const { rest } = parseMarker(notes);
  const parts = [];
  if (min !== null && min !== undefined && min !== '') parts.push(`min=${roundQty(min)}`);
  if (target !== null && target !== undefined && target !== '') parts.push(`target=${roundQty(target)}`);
  let base = rest.trimEnd();
  if (!parts.length) return base.slice(0, MAX_TEXT) || null;
  const marker = `[stock ${parts.join(' ')}]`;
  const room = MAX_TEXT - marker.length - 1;
  if (base.length > room) base = base.slice(0, Math.max(0, room)).trimEnd();
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
 * The category of a product whose batches disagree: the majority wins, a tie
 * goes to the primary (marked) batch. One batch filed under "Food" by mistake
 * must not move the whole product out of the household view.
 */
export function majorityCategory(batches, primary) {
  const counts = new Map();
  for (const b of batches) counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
  let best = primary.category;
  let bestCount = counts.get(best) ?? 0;
  for (const [category, count] of counts) {
    if (count > bestCount) { best = category; bestCount = count; }
  }
  return best;
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
      category: majorityCategory(batches, primary),
      batches,
      primary,
      total,
      min,
      target: marker.target,
    });
  }
  return products.sort((a, b) => a.name.localeCompare(b.name));
}

/** The product whose name matches, ignoring case and surrounding spaces. */
export function findByName(products, name) {
  const wanted = String(name ?? '').trim().toLocaleLowerCase();
  if (!wanted) return null;
  return products.find((p) => p.name.toLocaleLowerCase() === wanted) ?? null;
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

/**
 * Which batch a product-level "+1" goes to: the one "-1" last took from (the
 * tube in use), otherwise the storage batch: expires last, then the largest,
 * then the oldest.
 */
export function pickBatchForPut(batches, lastBatchId = null) {
  const all = batches ?? [];
  const last = lastBatchId === null || lastBatchId === undefined
    ? null
    : all.find((b) => String(b.id) === String(lastBatchId));
  if (last) return last;
  const sorted = [...all].sort((a, b) => {
    const ea = a.expires_on ?? '9999-12-31';
    const eb = b.expires_on ?? '9999-12-31';
    if (ea !== eb) return ea > eb ? -1 : 1;
    if (Number(a.quantity) !== Number(b.quantity)) return Number(b.quantity) - Number(a.quantity);
    return a.id - b.id;
  });
  return sorted[0] ?? null;
}

/** Step size per unit, matching Yuvomi's pantry stepper. */
export function stepFor(unit) {
  if (unit === 'g' || unit === 'ml') return 100;
  if (unit === 'kg' || unit === 'l') return 0.5;
  return 1;
}

/**
 * What a stepper tap does to a batch and its product, without touching the
 * server: the batch's next quantity, the product total afterwards, and how
 * much the module should offer to buy when the tap crossed the minimum
 * (0 when it did not).
 */
export function applyDelta(product, batch, delta) {
  const next = roundQty(Number(batch.quantity) + delta);
  const after = roundQty(product.total - Number(batch.quantity) + next);
  let promptAmount = 0;
  if (delta < 0 && crossedMinimum(product.total, after, product.min)) {
    promptAmount = restockAmount({ ...product, total: after });
  }
  return { next, after, promptAmount };
}

/** Replace one pantry row by id (a PATCH response) without reloading the list. */
export function mergeItem(items, row) {
  if (!row || row.id === undefined || row.id === null) return items;
  const list = items ?? [];
  const at = list.findIndex((i) => i.id === row.id);
  if (at === -1) return [...list, row];
  return list.map((i, idx) => (idx === at ? { ...i, ...row } : i));
}

/** Whole calendar days from todayKey to dateKey (negative = in the past), or null. */
export function daysUntil(dateKey, todayKey) {
  const parse = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key ?? ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const to = parse(dateKey);
  const from = parse(todayKey);
  if (!Number.isFinite(to) || !Number.isFinite(from)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** 'expired' | 'soon' | null, like the core pantry's expiry badge. */
export function expiryStatus(dateKey, todayKey, soonDays = EXPIRY_SOON_DAYS) {
  const days = daysUntil(dateKey, todayKey);
  if (days === null) return null;
  if (days < 0) return 'expired';
  if (days <= soonDays) return 'soon';
  return null;
}

/** True for a batch that is expired or expires within EXPIRY_SOON_DAYS. */
export function expiresSoon(dateKey, todayKey, soonDays = EXPIRY_SOON_DAYS) {
  return expiryStatus(dateKey, todayKey, soonDays) !== null;
}

/** Filter products by view ('household' | 'food' | 'all') and status ('low' | null). */
export function filterProducts(products, { view = 'household', householdCategories = [], status = null, query = '' } = {}) {
  const household = new Set(householdCategories);
  const q = String(query ?? '').trim().toLocaleLowerCase();
  return products.filter((p) => {
    if (view === 'household' && !household.has(p.category)) return false;
    if (view === 'food' && household.has(p.category)) return false;
    if (status === 'low' && productStatus(p) === 'ok') return false;
    if (q && !p.name.toLocaleLowerCase().includes(q)) return false;
    return true;
  });
}

/** Household categories from a comma separated string (widget option). */
export function parseCategoryList(raw, fallback = []) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}
