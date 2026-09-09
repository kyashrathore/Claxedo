# OpenCode v2 icon extraction

All 37 entries from `packages/ui/src/components/opencode-v2-artwork.tsx`, consumed by `packages/ui/src/v2/components/icon.tsx`, copied with original viewBoxes and geometry. The manifest records SHA-256 hashes and duplicate references.

Run `bun run --cwd packages/ui extract:icons` to regenerate both OpenCode inventories. Verify with `bun test --cwd packages/ui src/storybook/opencode-icon-extraction.test.ts`. Storybook shows these alongside v1 and provides full downloads. The v2 diff expand/collapse and split/unified drawings are applied within the OpenCode family.
