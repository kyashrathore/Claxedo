# OpenCode UI icon extraction

`sprite.svg` and `manifest.json` capture every renderer glyph in the artwork table
in `packages/ui/src/components/icon.tsx`. Names and SVG viewBoxes come from that
renderer. Geometry is copied without resizing, redrawing, or normalizing paths.
The manifest records SHA-256 hashes and duplicate references when present.

Regenerate from the repository root:

```sh
bun run --cwd packages/ui extract:icons
```

Verify the snapshot against the current producer:

```sh
bun test --cwd packages/ui src/storybook/opencode-icon-extraction.test.ts
```

Storybook's **Reference / Codex Icon System / Complete Reference** shows this
complete renderer inventory, the full app semantic mapping in both libraries,
and paired interaction examples. Its download links serve these checked-in
snapshots. Filtering the gallery does not filter the export. The snapshot test
fails if the source artwork changes without regeneration.

The gallery renders current source artwork, not these snapshots. Its comparison
controls use reference interaction styles; they do not certify production
controls' behavior. The existing Codex extraction retains its own provenance in
the sibling `codex` directory. Provider, file-type, and application-logo sprites
have their separate galleries; this inventory covers the `OpenCodeIcon` interface glyph system, including its existing local helpers.

The same command also exports all 37 v2 glyphs into `../opencode-v2/`, with the same hashes and coordinate-preservation checks. Storybook displays both inventories and labels their source version.
