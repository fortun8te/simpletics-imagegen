# Harness Improvement Plan

## Issues Identified

### 1. Text Extraction & Recognition
- **Current State**: `layout-extract.mjs` uses vision model to extract text but often misses text in complex images
- **Problem**: No dedicated OCR fallback when vision model fails; text boxes may be inaccurate
- **Impact**: Ad 78 and others don't match reference text accurately

### 2. SVG & Vector Shape Handling  
- **Current State**: `shapeKind:'arrow'`, `'line'`, `'polyline'`, `'path'` supported but extraction may miss them
- **Problem**: Arrows and vector shapes not reliably detected from reference images
- **Impact**: Harness mishandles SVGs and arrows, misses vector shapes

### 3. Self-Review & Comparison
- **Current State**: `self-vision.mjs` has `compareToReference` and `scoreFidelity` but only runs post-generation
- **Problem**: No iterative self-correction loop during extraction; can't compare output with original mid-process
- **Impact**: Harness doesn't check its own work and lacks tools to fix issues

### 4. Raster vs Vector Decisions
- **Current State**: Elements system creates raster images for some elements that could be vectors
- **Problem**: Excessive pixel blur from unnecessary rasterization
- **Impact**: Poor quality output, especially for icons and simple shapes

### 5. Icon Handling
- **Current State**: `notes-icons.mjs` has curated Apple Notes icons but no general icon detection
- **Problem**: Icons not properly cropped, background not removed, layers incorrect
- **Impact**: Icon handling is poor; when icons can't be reproduced accurately, fallback fails

### 6. Layer Structure for Figma Export
- **Current State**: `groupIntoRegions` exists but is basic; Figma export via HTML works but could be better
- **Problem**: Bad layering, improper groups, no semantic grouping during extraction
- **Impact**: Difficult to use in Figma, requires extensive manual editing

## Improvement Strategy

### Phase 1: Agent 1 - Text & Vision Enhancement
**Files to Modify:**
- `studio/lib/layout-extract.mjs` - Enhanced text detection with OCR fallback
- `studio/lib/self-vision.mjs` - Iterative comparison loop during extraction
- `studio/lib/design-agent.mjs` - Integration of comparison feedback

**Key Changes:**
1. Add multi-pass text extraction (vision model + pixel-based OCR fallback)
2. Implement mid-process comparison with reference image
3. Add structured correction feedback to extraction loop
4. Enhance `compareToReference` to provide actionable fixes

### Phase 2: Agent 2 - Vector & Icon Processing
**Files to Modify:**
- `studio/lib/elements.mjs` - Smart vector/raster decision logic
- `studio/lib/layout-extract.mjs` - Improved shape detection
- `studio/lib/notes-icons.mjs` - General icon handling framework

**Key Changes:**
1. Add shape complexity analysis to decide vector vs raster
2. Implement arrow/polyline detection from pixel analysis
3. Create icon extraction pipeline with background removal
4. Add shape path extraction for simple vector shapes

### Phase 3: Agent 3 - Layer Structure & Figma Export
**Files to Modify:**
- `studio/lib/design-agent.mjs` - Enhanced grouping logic
- `studio/lib/designstore.mjs` - Improved HTML/SVG export with proper layers
- `studio/lib/design-verify.mjs` - Layer structure validation

**Key Changes:**
1. Implement semantic grouping during extraction (Header, Body, CTA, Product)
2. Add meaningful layer naming based on content analysis
3. Enhance Figma clipboard export with proper hierarchy
4. Add layer structure validation before export

## Implementation Order

1. **Immediate**: Create the three agent scripts
2. **Agent 1**: Run text/vision improvements first (foundation for comparison)
3. **Agent 2**: Run vector/icon improvements (depends on better extraction)
4. **Agent 3**: Run layer structure improvements (depends on better content detection)

## Success Metrics

1. **Text Accuracy**: Ad 78 should match reference text exactly
2. **Vector Handling**: Arrows and simple shapes should be vectors, not rasters
3. **Self-Review**: Each extraction should include comparison score and corrections
4. **Layer Structure**: Figma export should have clean, semantic layer hierarchy
5. **Overall**: 32 ad batch should show measurable improvement in fidelity scores

## Testing Approach

1. Run 32 ads through improved harness
2. Compare fidelity scores before/after
3. Verify Figma export layer structure
4. Check text accuracy against references
5. Validate vector shapes are properly handled
