# Graveyard

Code that is currently unwired (zero importers, so a strict dead-code sweep
would delete it) but ties to a planned feature and shouldn't be lost. Anything
here is fair game to resurrect — just re-import it where it's needed and move
it back out of this directory.

## nativeIcons.ts

Curated real vector icon paths for native-UI chrome (X/Twitter, Instagram,
etc.) — for the planned native-icons library used when recomposing
per-platform native ad chrome. Not yet wired into any component.

## ImageActions.tsx (+ .module.css)

Self-contained "Cut out subject" action for an image layer — the planned
cut-out UI entry point (calls into the server-side cutout op; see
`autoCutoutShape` / `CutoutMaskShape` in `src/lib/sceneGraph.ts`, which are
kept live for this reason). Not yet wired into the Editor/Stage image-layer
context menu.
