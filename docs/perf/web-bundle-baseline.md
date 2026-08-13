# Web bundle baseline — authenticated app (vite.cloud.config.ts)

Captured 2026-08-13 on `claude/claxedo-perf-optimization-1yzgej` at the branch point
(`9bf0a8a` + the renderer-trace build fix), before any bundle work. Build command:
`bun run build` in `packages/claxedo-app` (vite 7.1.4, production). This is the
first measurement of the web surface — the desktop effort's ten gates never
covered it (docs/perf/HANDOFF.md §1.2).

## Eager boot set (what a signed-in user downloads before first paint)

| asset | raw | gzip |
|---|---:|---:|
| `main-*.js` | 2,585.3 kB | 748.4 kB |
| `vendor-solid-*.js` | 34.3 kB | — |
| `vendor-clerk-*.js` | 0.1 kB (dynamic trigger only) | — |
| `main-*.css` | 475.1 kB | — |

828 JS assets total in dist/assets; the rest are lazy chunks (shiki grammars,
mermaid, xterm, tiptap, review workspace, …).

## Main-chunk attribution (sourcemap byte attribution, top offenders)

| source | bytes (min) | verdict at baseline |
|---|---:|---|
| `src/features/session` | 299 kB | app code, partly legitimate |
| `@pierre/diffs` | 267 kB | **guard-forbidden, leaked** |
| `zod` | 252 kB | pulled by workgraph contracts + 3 boot files |
| shiki stack (7 pkgs) | ~170 kB | **guard-forbidden, leaked** |
| `@kobalte/core` | 131 kB | legitimate (UI primitives) |
| `src/features/settings` | 82 kB | leaked via entry barrel re-export |
| `@tanstack/ai` + `ai-client` | 67 kB | **guard-forbidden, leaked** |
| `marked` + `dompurify` | 63 kB | guard-forbidden (jsParser dead in native mode) |
| `motion-dom` | 56 kB | legitimate (core interaction animations) |
| `src/platform/i18n` | 54 kB | legitimate (en fallback dict is sync) |
| `@claxedo/workgraph/contracts` | 52 kB | rides with zod via feature-ports |
| `sdk.gen.ts` | 49 kB | legitimate (API client) |
| `src/features/onboarding` | 47 kB | leaked via settings barrel chain |
| `ui/components/icon.tsx` | 45 kB | inline SVG strings; sprite idea untested |
| katex | 0 in main, but **two full copies** as lazy chunks (0.16.27 via ui/session-ui pin, 0.16.47 via mermaid) | deduped in this effort |

## Guard state at baseline

`scripts/check-forbidden-eager-deps.ts` (static) FAILED: @tanstack/ai-client, qrcode.
`scripts/check-main-chunk-markers.ts` (build artifact) FAILED: katex, marked,
@pierre/diffs+shiki, @tanstack/ai-client. The static walker cannot see the
chains through packages/session-ui and @opencode-ai/ui subpaths, which is how
three of the five leaked without tripping it.

## Measurement notes

- Byte attribution script: decode the chunk's own sourcemap mappings and sum
  generated-column spans per source (see scratchpad attribute-bytes.mjs in the
  session; rebuildable from this description in ~60 lines).
- The build emits hidden sourcemaps (`sourcemap: "hidden"`), so attribution
  needs no config change.
- gzip figures are vite's report (`gzip: …`), raw are minified bytes.
