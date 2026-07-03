# figma-kiwi (vendored)

Minimal encoder/decoder for Figma's native clipboard payload (`text/html` with a
base64 `fig-kiwi` binary archive), used by "Copy to Figma as native layers".

## Provenance / attribution

- **Format**: Figma's clipboard/.fig container uses the [kiwi](https://github.com/evanw/kiwi)
  binary format (MIT, Evan Wallace). The payload embeds its own binary schema, so a writer
  only needs a valid schema chunk plus a message encoded against it.
- **`schema.ts`**: the deflate-compressed kiwi binary schema chunk, extracted byte-for-byte
  from a real Figma clipboard sample (format version 46) published in
  [interlace-app/fig-kiwi-toolbox](https://github.com/interlace-app/fig-kiwi-toolbox)
  (`src/utils/sampleData.ts`). The bytes originate from Figma's own copy operation — this is
  interface/wire-format description data, not creative content. If Figma ever rejects old
  schema versions, re-capture: copy anything inside Figma, read `text/html` off the clipboard,
  and replace the base64 of archive chunk 0.
- **Code**: `index.ts` was written for this repo. The archive layout and HTML wrapper follow
  the public reverse-engineering work of [darknoon/fig-kiwi](https://www.npmjs.com/package/fig-kiwi)
  and fig-kiwi-toolbox; no code was copied from either.
- **Runtime deps** (frontend only): `kiwi-schema` (MIT), `pako` (MIT).
