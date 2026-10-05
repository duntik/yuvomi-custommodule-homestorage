// Every tx('key') used by the module must exist in every locale file, and no
// locale may carry keys the code never uses. Run: node scripts/check-locales.mjs
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../modules/household-supplies/', import.meta.url);
const files = ['index.js', 'view.js', 'actions.js', ...readdirSync(new URL('widgets/', dir)).map((f) => `widgets/${f}`)];
const sources = files.map((f) => {
  try { return readFileSync(new URL(f, dir), 'utf8'); } catch { return ''; }
}).join('\n');

// The first argument of every tx(...) call, including ternaries: tx(a ? 'x' : 'y').
const used = new Set();
for (const call of sources.matchAll(/\btx\(([^,)]*)/g)) {
  for (const key of call[1].matchAll(/'([a-zA-Z_.]+)'/g)) used.add(key[1]);
}
// Keys built from a prefix plus a runtime value.
for (const v of ['household', 'food', 'all']) used.add(`view_${v}`);
for (const s of ['low', 'empty']) used.add(`status_${s}`);
// Keys the manifest references via labelKey / titleKey.
const manifest = JSON.parse(readFileSync(new URL('module.json', dir), 'utf8'));
for (const key of JSON.stringify(manifest).matchAll(/"(?:labelKey|titleKey)":"([^"]+)"/g)) used.add(key[1]);

let failed = false;
for (const file of readdirSync(new URL('locales/', dir)).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(new URL(`locales/${file}`, dir), 'utf8');
  const dict = JSON.parse(text);
  // A key with a {{count}} parameter may be shipped as key_one / key_few / key_other.
  const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '');
  const present = new Set(Object.keys(dict).map(base));
  const missing = [...used].filter((k) => !present.has(k));
  const unused = Object.keys(dict).filter((k) => !used.has(base(k)));
  const dashes = /[–—]/.test(text);
  if (missing.length || unused.length || dashes) failed = true;
  console.log(`${file}: ${Object.keys(dict).length} keys, missing: ${missing.join(', ') || 'none'}, unused: ${unused.join(', ') || 'none'}${dashes ? ', contains en/em dashes' : ''}`);
}
console.log(`${used.size} keys used in code and manifest`);
process.exit(failed ? 1 : 0);
