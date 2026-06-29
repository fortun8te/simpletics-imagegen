// products.mjs
//
// Real product knowledge for the Simpletics image generator. The recurring
// problem is products coming out the wrong scale (usually too big), so this
// helper gives prompt builders a natural, real-world size anchor to inject.
//
// Usage in a prompt builder:
//
//   import { sizeAnchor, getProduct } from './products.mjs';
//
//   const key = 'sea-salt-spray';
//   const p = getProduct(key);
//   const prompt = [
//     `Hold the ${p.name} (${p.form}, ${p.colorNote}).`,
//     `Scale reference: it is ${sizeAnchor(key)}.`,
//     'Keep the product at that real-world size, do not oversize it.'
//   ].join(' ');
//
// getProduct and sizeAnchor are tolerant of short aliases like "spray",
// "saltspray", "clay", "mousse", "powder".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const data = JSON.parse(
  readFileSync(join(__dirname, 'products.json'), 'utf8')
);

const PRODUCTS = Array.isArray(data.products) ? data.products : [];

// Alias map: short, loose names a prompt or briefs doc might use, mapped to
// the canonical product key.
const ALIASES = {
  'saltspray': 'sea-salt-spray',
  'salt-spray': 'sea-salt-spray',
  'sea-salt': 'sea-salt-spray',
  'spray': 'sea-salt-spray',
  'vanilla-voyage': 'sea-salt-spray',
  'clay': 'matte-clay',
  'matte': 'matte-clay',
  'hair-clay': 'matte-clay',
  'mousse': 'curl-mousse',
  'curl': 'curl-mousse',
  'powder': 'texturizing-powder',
  'texture-powder': 'texturizing-powder',
  'texturizing': 'texturizing-powder'
};

function normalize(key) {
  if (!key) return '';
  return String(key).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// getProduct(key) returns the product entry, or null if unknown.
export function getProduct(key) {
  const n = normalize(key);
  if (!n) return null;
  const canonical = ALIASES[n] || n;
  return PRODUCTS.find((p) => p.key === canonical) || null;
}

// sizeAnchor(key) returns the natural size-anchor phrase, or '' if unknown.
export function sizeAnchor(key) {
  const p = getProduct(key);
  return p && p.sizeAnchor ? p.sizeAnchor : '';
}

// productList() returns all product entries.
export function productList() {
  return PRODUCTS.slice();
}

export default { getProduct, sizeAnchor, productList };
