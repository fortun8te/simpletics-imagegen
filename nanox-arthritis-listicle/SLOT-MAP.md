# Arthritis image swap — slot map (OG file -> generated tile)

This is a 1:1 replacement of the OG (back-pain) images with arthritis images. Each grid tile is its
own generation. Batch: `nanox / b2` (Arthritis Listicle). Generated files land under
`~/Downloads/static-factory-b1/renders/nanox/b2/ads/<AD>/<VAR>/p1/run-1.png`.

## Page slots that change (the SWAPS)

| Page slot (section) | OG file to replace | Source ad | Tiles needed | Assembly |
|---|---|---|---|---|
| Reason 3 application (single) | `a86da982-...png` | `AD-ART-01` | pick 1 of 3 (A/B/C) | none, single image |
| Hero (2x2 collage) | `2x2-grid.png` | `AD-ART-02` | A,B,C,D (4) | 4 tiles -> 2x2 |
| Reason 4 (3x3 collage) | `3x3-grid.png` | `AD-ART-03` | A,B,C,D,E,F,G,H,I (9) | 9 tiles -> 3x3 |
| Reason 3 testimonial face (Joe) | `ChatGPT_...02_12_04...png` | `AD-ART-04/A` | 1 | single circular portrait |
| Reason 4 card faces (Dale / Carol / Janet) | `r4_dale / r4_carol / r4_janet` | `AD-ART-04/B,C,D` | 3 | single circular portraits |

## Tile -> grid position

**2x2 (AD-ART-02):**  A = top-left · B = top-right · C = bottom-left · D = bottom-right (tube)

**3x3 (AD-ART-03), row-major:**
```
A  B  C(tube)
D  E  F(tube)
G  H  I(tube)
```

## KEEP (do not regenerate — product/mechanism, angle-neutral)
Reason 1 tube-on-grass + 6 ingredient icons · Reason 2 cross-section diagram (already says "muscle and
joint") · Reason 5 guarantee shot · Offer tube. (The 4 testimonial portraits are now generated — AD-ART-04.)

## Candidate counts (lean, @VARIANTS=1)
- AD-ART-01 hero hands: 3 framings, pick the best 1 (hands are hardest for AI).
- AD-ART-02: 1 per tile, +1 safety take on the tube tile (D).
- AD-ART-03: 1 per tile, +1 safety take on tube tiles (C, F, I).
- Total 20 images. Bump with `VARIANTS=2` for two candidates everywhere; regen a single ad/tile by id.

## After generation: you assemble the grids
Decided: the batch generates every tile as a SEPARATE image; you edit/build the 2x2 and 3x3 grids
yourself. Grab each tile at its path below and drop it into the grid position from the maps above.

Exact tile output paths (`~/Downloads/static-factory-b1/renders/`):
- Hero hands (pick 1): `nanox/b2/ads/AD-ART-01/{A,B,C}/p1/run-1.png`
- 2x2 tiles: `nanox/b2/ads/AD-ART-02/{A,B,C,D}/p1/run-1.png`  (D also has `/p2/run-1.png` safety take)
- 3x3 tiles: `nanox/b2/ads/AD-ART-03/{A..I}/p1/run-1.png`  (C,F,I also have `/p2/run-1.png`)
- Reviewer portraits: `nanox/b2/ads/AD-ART-04/{A,B,C,D}/p1/run-1.png`  (A=Joe, B=Dale, C=Carol, D=Janet)
