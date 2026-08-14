# 02 — Design system & theming ("same look")

## Scope
Token pipeline, gpui-component theme generation, fonts, icons, dark/light/
system scheme, and the pixel-parity harness that DEFINES "same look".

## Current implementation
- Tokens: `packages/ui/src/styles/theme.css` (+ ~48.6 kB :root definitions),
  runtime resolution `packages/ui/src/theme/resolve.ts` + `v2/resolve.ts`,
  scheme handling `theme/context.tsx`, guard `scripts/check-theme-tokens.ts`.
- First-paint theme: `public/oc-theme-preload.js` (localStorage → data-theme
  before paint).
- Icons: 110-symbol OpenCode sprite in `packages/ui/src/components/icon.tsx`
  (+ codex/file/provider lazy sprite assets, `inline-svg-sprite.ts`).
- Fonts: system-ui stack; terminal-only JetBrainsMono Nerd Font woff2.

## Target design
- ONE token source (JSON/TOML distilled from theme.css) compiled two ways:
  → CSS custom properties (web/Solid keeps working, W2), and
  → `gpui-component` Theme (it ships JSON theme support; map color tokens,
    radii, spacing, typography scale). The compiler is a small build tool
    with a golden test asserting both outputs stay in sync.
- Icons: the SVGs render natively (GPUI `svg()`); generate a Rust icon enum
  from the same sprite source files.
- Fonts: bundle the Nerd Font for terminal; match system stack per-platform;
  document metric differences (line-height rounding differs from Chromium —
  the parity harness must tolerance-band text surfaces).

## Parity harness (the "same look" gate)
Per-surface screenshot pairs: Solid app (Playwright) vs GPUI app (its own
screenshot API) on the same seeded corpus, same window size, both themes.
Gate = SSIM/pixel-diff within a per-surface budget agreed once (text
surfaces get a looser band than chrome/layout surfaces). Store baselines in
the repo like `perf-harness/reports` trends.

## Spike + kill criterion
Compile the token set → render the rail sidebar chrome (no data) in GPUI
next to the web rail; diff. KILL if >3 tokens have no GPUI-expressible
equivalent (e.g. backdrop-filter usage inventory first).
