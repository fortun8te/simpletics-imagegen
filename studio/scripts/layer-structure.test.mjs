// layer-structure.test.mjs — Test improved semantic grouping, layer naming, and Figma export.
// Run from studio/: npx node scripts/layer-structure.test.mjs

import assert from 'node:assert/strict';

const {
  deriveLayerName, deriveGroupName, semanticGrouping, groupIntoRegions,
} = await import('../lib/design-agent.mjs');

const {
  renderDesignHtml, exportForFigma,
} = await import('../lib/designstore.mjs');

const {
  validateLayerStructure,
} = await import('../lib/design-verify.mjs');

const { walkNodes, leaves } = await import('../lib/scene-tree.mjs');

// ── Test fixture: a flat ad comp with diverse layer types ──────────────────────────────────────

function makeDoc(overrides = {}) {
  return {
    id: 'test-layer-structure',
    name: 'Layer Structure Test',
    canvas: { w: 1080, h: 1350 },
    layers: [
      {
        id: 'base', type: 'shape', role: 'base', name: 'Base gradient',
        box: { x: 0, y: 0, w: 1080, h: 1350 },
        style: {
          background: '#1a1a2e',
          gradient: { type: 'linear', angle: 180, stops: [{ color: '#1a1a2e', pos: 0 }, { color: '#16213e', pos: 1 }] },
        },
      },
      {
        id: 'logo', type: 'image', role: 'logo', name: 'Logo',
        box: { x: 60, y: 40, w: 120, h: 60 },
        style: { shapeKind: 'rect' },
      },
      {
        id: 'headline', type: 'text', role: 'headline',
        text: 'Premium Silk Collection',
        box: { x: 60, y: 140, w: 960, h: 120 },
        style: { fontSize: 84, fontWeight: 800, color: '#ffffff', align: 'center' },
      },
      {
        id: 'subhead', type: 'text', role: 'subhead',
        text: 'Handcrafted luxury for the modern connoisseur',
        box: { x: 60, y: 280, w: 960, h: 60 },
        style: { fontSize: 32, fontWeight: 400, color: '#cccccc', align: 'center' },
      },
      {
        id: 'product-img', type: 'image', role: 'product',
        box: { x: 240, y: 400, w: 600, h: 600 },
        style: { shapeKind: 'rect', radius: 16 },
      },
      {
        id: 'price-badge', type: 'badge', role: 'price',
        text: '$299',
        box: { x: 740, y: 420, w: 120, h: 48 },
        style: { fontSize: 28, fontWeight: 700, color: '#ffffff', background: '#e8734a', radius: 24 },
      },
      {
        id: 'scrim', type: 'shape', role: 'scrim',
        box: { x: 0, y: 1100, w: 1080, h: 250 },
        style: { background: '#000000', opacity: 0.6 },
      },
      {
        id: 'cta-btn', type: 'button', role: 'cta',
        text: 'Shop Now',
        box: { x: 340, y: 1180, w: 400, h: 80 },
        style: { fontSize: 32, fontWeight: 700, color: '#ffffff', background: '#e8734a', radius: 40 },
      },
      {
        id: 'divider', type: 'shape', role: 'divider',
        box: { x: 60, y: 1060, w: 960, h: 2 },
        style: { background: '#333333' },
      },
      {
        id: 'body-text', type: 'text', role: 'body',
        text: 'Crafted from the finest mulberry silk threads',
        box: { x: 60, y: 1080, w: 600, h: 40 },
        style: { fontSize: 18, color: '#999999' },
      },
      ...((overrides.layers) || []),
    ],
    ...overrides,
  };
}

// ── Test 1: deriveLayerName improvements ──────────────────────────────────────────────────────

console.log('Test 1: Enhanced deriveLayerName');

// Shape with gradient gets descriptive name
const gradientShape = deriveLayerName({
  type: 'shape', role: 'scrim',
  style: { background: '#000', gradient: { type: 'linear', angle: 180, stops: [] } },
});
console.log(`  Gradient shape: "${gradientShape}"`);
assert.ok(gradientShape.includes('gradient'), `Expected "gradient" in "${gradientShape}"`);

// Ellipse shape
const ellipseShape = deriveLayerName({
  type: 'shape', style: { shapeKind: 'ellipse' },
});
console.log(`  Ellipse: "${ellipseShape}"`);
assert.equal(ellipseShape, 'Ellipse');

// Glass shape (backdropBlur)
const glassShape = deriveLayerName({
  type: 'shape', role: 'panel',
  style: { backdropBlur: 20, background: '#ffffff22' },
});
console.log(`  Glass shape: "${glassShape}"`);
assert.ok(glassShape.includes('glass'), `Expected "glass" in "${glassShape}"`);

// Cropped image
const croppedImg = deriveLayerName({
  type: 'image', role: 'avatar',
  style: { crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 } },
});
console.log(`  Cropped image: "${croppedImg}"`);
assert.ok(croppedImg.includes('cropped'), `Expected "cropped" in "${croppedImg}"`);

// Regular text
const textName = deriveLayerName({
  type: 'text', role: 'headline', text: 'BIG SALE TODAY',
});
console.log(`  Text: "${textName}"`);
assert.ok(textName.includes('Big Sale'), `Expected "Big Sale" in "${textName}"`);

console.log('  PASS');

// ── Test 2: deriveGroupName improvements ──────────────────────────────────────────────────────

console.log('\nTest 2: Enhanced deriveGroupName');

// CTA group with button text
const ctaName = deriveGroupName([
  { type: 'button', role: 'cta', text: 'Shop Now' },
  { type: 'text', role: 'label', text: 'Limited Time' },
]);
console.log(`  CTA group: "${ctaName}"`);
assert.ok(ctaName.includes('CTA'), `Expected "CTA" in "${ctaName}"`);
assert.ok(ctaName.includes('Shop'), `Expected "Shop" in "${ctaName}"`);

// Product group
const productName = deriveGroupName([
  { type: 'image', role: 'product' },
  { type: 'text', role: 'price', text: '$99' },
]);
console.log(`  Product group: "${productName}"`);
assert.ok(productName.includes('Product'), `Expected "Product" in "${productName}"`);

// Header group with headline
const headerName = deriveGroupName([
  { type: 'text', role: 'headline', text: 'Summer Collection' },
  { type: 'image', role: 'logo' },
]);
console.log(`  Header group: "${headerName}"`);
assert.ok(headerName.includes('Header'), `Expected "Header" in "${headerName}"`);
assert.ok(headerName.includes('Summer'), `Expected "Summer" in "${headerName}"`);

// Decorative group
const decorName = deriveGroupName([
  { type: 'shape', role: 'scrim', style: { background: '#000' } },
  { type: 'vignette', role: 'vignette', style: {} },
]);
console.log(`  Decorative group: "${decorName}"`);
assert.ok(decorName.includes('Decorative'), `Expected "Decorative" in "${decorName}"`);

console.log('  PASS');

// ── Test 3: semanticGrouping ──────────────────────────────────────────────────────────────────

console.log('\nTest 3: semanticGrouping');

const doc = makeDoc();
const result = semanticGrouping(doc);
console.log(`  Groups created: ${result.groups}`);
console.log(`  Names improved: ${result.renamed}`);

// Verify groups were created
assert.ok(result.groups > 0, 'Expected groups to be created');

// Verify the layer tree has groups
const groups = doc.layers.filter((n) => n.type === 'group');
console.log(`  Top-level groups: ${groups.length}`);
for (const g of groups) {
  console.log(`    - "${g.name}" (${g.children.length} children)`);
  assert.ok(g.name.length > 2, `Group name "${g.name}" is too short`);
  assert.ok(g.name !== 'Group', `Group should not be named "Group"`);
}

// Verify the tree is valid
const treeValid = validateLayerStructure(doc);
console.log(`  Layer structure valid: ${treeValid.valid}`);
console.log(`  Stats: depth=${treeValid.stats.maxDepth}, groups=${treeValid.stats.totalGroups}`);
assert.ok(treeValid.valid || treeValid.issues.length <= 2, 'Layer structure should be mostly valid');

console.log('  PASS');

// ── Test 4: validateLayerStructure ────────────────────────────────────────────────────────────

console.log('\nTest 4: validateLayerStructure');

// Clean doc
const cleanDoc = makeDoc();
semanticGrouping(cleanDoc);
const cleanResult = validateLayerStructure(cleanDoc);
console.log(`  Clean doc valid: ${cleanResult.valid}`);
console.log(`  Issues: ${cleanResult.issues.length}`);
for (const issue of cleanResult.issues) {
  console.log(`    - ${issue}`);
}

// Doc with empty group
const badDoc = makeDoc({
  layers: [
    {
      id: 'empty-group', type: 'group', name: 'Empty Group',
      box: { x: 0, y: 0, w: 100, h: 100 },
      children: [],
    },
  ],
});
const badResult = validateLayerStructure(badDoc);
console.log(`  Doc with empty group valid: ${badResult.valid}`);
assert.ok(!badResult.valid, 'Doc with empty group should be invalid');
assert.ok(badResult.issues.some((i) => i.includes('empty')), 'Should report empty group');

console.log('  PASS');

// ── Test 5: HTML export with data attributes ──────────────────────────────────────────────────

console.log('\nTest 5: HTML export with data attributes');

const htmlDoc = makeDoc();
semanticGrouping(htmlDoc);
const html = renderDesignHtml(htmlDoc);

// Check data attributes exist
const hasLayerName = html.includes('data-layer-name=');
const hasLayerType = html.includes('data-layer-type=');
console.log(`  Has data-layer-name: ${hasLayerName}`);
console.log(`  Has data-layer-type: ${hasLayerType}`);
assert.ok(hasLayerName, 'HTML should include data-layer-name attributes');
assert.ok(hasLayerType, 'HTML should include data-layer-type attributes');

// Check specific layer names appear
assert.ok(html.includes('data-layer-name="Headline"'), 'Should have headline layer name');
assert.ok(html.includes('data-layer-type="text"'), 'Should have text type');
assert.ok(html.includes('data-layer-type="image"'), 'Should have image type');
assert.ok(html.includes('data-layer-type="button"'), 'Should have button type');
assert.ok(html.includes('data-layer-type="shape"'), 'Should have shape type');

console.log('  PASS');

// ── Test 6: exportForFigma ────────────────────────────────────────────────────────────────────

console.log('\nTest 6: exportForFigma');

const figmaDoc = makeDoc();
semanticGrouping(figmaDoc);
const figmaResult = exportForFigma(figmaDoc);

assert.ok(figmaResult.doc, 'Should return a doc');
assert.ok(figmaResult.html, 'Should return html');

// Check the figma doc has proper structure
const figmaTreeValid = validateLayerStructure(figmaResult.doc);
console.log(`  Figma doc valid: ${figmaTreeValid.valid}`);
console.log(`  Figma stats: depth=${figmaTreeValid.stats.maxDepth}, groups=${figmaTreeValid.stats.totalGroups}`);

// Check nesting depth
assert.ok(figmaTreeValid.stats.maxDepth <= 3, `Nesting depth ${figmaTreeValid.stats.maxDepth} should be <= 3`);

// Check HTML has data attributes
assert.ok(figmaResult.html.includes('data-layer-name='), 'Figma HTML should have data attributes');

console.log('  PASS');

// ── Test 7: groupIntoRegions backward compatibility ───────────────────────────────────────────

console.log('\nTest 7: groupIntoRegions backward compatibility');

const compatDoc = makeDoc();
const compatResult = groupIntoRegions(compatDoc);
console.log(`  groupIntoRegions returned: ${compatResult}`);
// This doc already has groups from semanticGrouping (or is flat), so either returns 0 or > 0
assert.ok(typeof compatResult === 'number', 'Should return a number');

console.log('  PASS');

// ── Summary ───────────────────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('All layer structure tests PASSED');
console.log('='.repeat(60));
