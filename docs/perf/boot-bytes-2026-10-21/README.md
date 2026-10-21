# What left the signed boot, 21 October 2026

The bundle lane ([bundle-build-2026-10-20](../bundle-build-2026-10-20/README.md)) left five costs in the signed web boot with owners. Four of them are fixed on `perf/boot-bytes`, one commit each. The fifth, prefetching the code views after first text, is measured and kept. The shell document's first wave falls from 2,594.1 kB raw and 590.7 kB brotli to 2,266.6 and 527.0. The cold root's rail paints 58 ms sooner on the India profile, and the cold session's text 61 ms sooner. A web boot no longer copies every CSS rule into each plugin control frame, which was 38 to 56 ms of main-thread time at 4x CPU.

## How it was measured

- **Bytes:** the cloud web build (`vite.cloud.config.ts`) of each commit, compressed with brotli 11 and attributed to source modules through the hidden source maps (`analyzeDist`, `packages/claxedo-app/e2e/perf/web/bytes.ts`).
- **Coverage:** `bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=1 --profile=none --coverage --dist=<build>`. The first wave is `main` and `preferences`, scripts and stylesheets. A module-level table counts as run, because its module ran.
- **Time:** `e2e:perf-web -- --reps=3 --profile=india-staging --dist=<build>` gives 100 ms to static, 300 ms to the API and 10 Mbps down. `--cpu=4` slows the CPU fourfold. Every build ran in one window, between 23:36 and 00:06 UTC on 20–21 October, on the shared host at load 6 to 12. dev `5725f06614` and the last commit ran twice each, and each cell pools those runs (n = 6). The commits in between ran once (n = 3).
- **Attribution:** a profile's time under one source file is read from the rig's sampled `.cpuprofile`, with each frame mapped through the build's source maps.

## First wave by commit

| build | `main.js` raw / br kB | `main.css` raw / br | first wave raw / br | first wave run at the cold root | at the cold session |
|---|---|---|---|---|---|
| dev `5725f06614` | 1,847.5 / 440.7 | 422.5 / 50.0 | 2,594.1 / 590.7 | 972.7 of 2,595.0 kB (37%) | 1,093.4 (42%) |
| zod and the surfaces lazy | 1,650.0 / 400.6 | 368.7 / 44.8 | 2,342.8 / 545.4 | 925.5 of 2,337.7 (40%) | 1,046.2 (45%) |
| motion's `animate` lazy | 1,610.3 / 389.5 | 368.7 / 44.8 | 2,303.1 / 534.3 | 920.8 of 2,298.0 (40%) | 1,041.6 (45%) |
| control frames without the stylesheet copy | 1,610.3 / 389.6 | 368.7 / 44.8 | 2,303.1 / 534.4 | 920.6 of 2,298.0 (40%) | 1,041.4 (45%) |
| settings dictionaries at their doors | 1,573.8 / 382.2 | 368.7 / 44.8 | 2,266.6 / 527.0 | 885.8 of 2,261.6 (39%) | 1,006.4 (44%) |

## Rig, India profile, p50

| step | dev | zod, surfaces | + motion | + frame CSS | + dictionaries |
|---|---|---|---|---|---|
| cold-root/boot, rail | 829 | 786 | 781 | 775 | 771 |
| cold root, main chunk's last byte | 722 | 684 | 673 | 672 | 672 |
| cold root, first contentful paint | 856 | 820 | 812 | 800 | 800 |
| cold root, `v8.evaluateModule` ms | 37.0 | 29.9 | 31.2 | 28.7 | 29.6 |
| cold root, requests / kB | 37 / 858 | 52 / 874 | 52 / 863 | 52 / 863 | 55 / 864 |
| cold-session/boot, session text | 1,701 | 1,651 | 1,635 | 1,643 | 1,640 |
| cold session, first contentful paint | 854 | 812 | 796 | 796 | 790 |
| warm-session/reload, session text | 572 | 571 | 574 | 566 | 570 |
| first-session/press, session text (kB) | 490 (189) | 480 (190) | 489 (204) | 474 (204) | 482 (204) |
| open-session/press, session text | 453 | 444 | 449 | 454 | 453 |
| lazy-pages/settings | 10.1 | 10.9 | 10.8 | 10.1 | 8.8 |
| signed-out-login/boot, form | 364 | 360 | 361 | 364 | 362 |
| onboarding/boot | 1,022 | 979 | 968 | 963 | 962 |

At 4x CPU (dev, motion, frame CSS and dictionaries, each run twice, p50 of six):

| step | dev | + motion | + frame CSS | + dictionaries |
|---|---|---|---|---|
| cold-root/boot, rail (busy ms) | 1,219 (602) | 1,172 (605) | 1,140 (566) | 1,140 (577) |
| cold-session/boot, text (busy) | 2,154 (1,128) | 2,062 (1,055) | 2,048 (987) | 2,046 (977) |
| warm-session/reload, text (busy) | 719 (537) | 697 (525) | 689 (461) | 693 (460) |
| first-session/press (busy) | 693 (453) | 689 (464) | 660 (408) | 678 (443) |
| onboarding/boot | 1,309 | 1,222 | 1,223 | 1,232 |
| `plugins/frame/styles.ts` in the cold session's profile | 43.0–56.3 ms | 37.8–43.0 | 0–1.0 | 0 |

The 4x session press was bimodal on every build, at about 520 ms or 720 ms. Dev's two runs had no slow rep, the frame-CSS build had one of six, and the dictionaries build four of six. In the slow reps the relay's three session reads answered about 200 ms later. The page's own time from those reads to the text was 78 to 84 ms in both modes, so the slow mode comes from the stack, not the page.

## The changes

### 1. zod, the A2UI catalog and the surface renderer leave the boot

The app reached them in three ways:

- **Icon names.** `src/surface/icon-names.ts` imported `SURFACE_ICON_NAMES` from `@claxedo/plugin-api`'s `surface/catalog.ts`. That module builds its zod schemas when it loads. The list now lives in `surface/icon-names.ts`, a module with no imports. The catalog and `transcript.ts` build their enums from it, so the list has one owner, and `icon-names.test.ts` checks both properties.
- **Statically imported renderers.** The transcript's `ui_show` renderer and the plugin host's surface pages were static imports. Both are now lazy views (`transcript/claxedo-tool-row.ts`, `plugins/surface-page/view-lazy.ts`). The session screen and the plugin host prefetch them once the first screen has settled.
- **Tool-card checks.** Every plugin's tool-card templates were checked with zod when the plugin registered them. A live build's templates are still checked before it activates, in a chunk of their own (`bindings/tool-card-check.ts`, behind `bindings/tool-card-intake.ts`). A bundled build's templates are the host's own code: the Tasks and Documents packages' `tool-cards.test.ts` checks them, the same way a bundled plugin is approved because the host ships it.

What leaves the first wave now arrives after settle as 15 smaller files of 62 kB brotli: zod's `schemas` (16.6), `surface-view` (17.1) and its stylesheet (4.7), and the Kobalte select, tabs, radio, switch and progress chunks the surfaces use. That is why the cold root sends 52 requests instead of 37.

### 2. motion's `animate`

Only two transcript sites called `animate`:

- `BasicTool`'s `animated` height path. No caller ever passed `animated`, so the path is removed.
- `ShellSubmessage`, which now loads `animate` through `transcript/tool-motion.ts`. The session screen prefetches it with the code views. Until it lands, the command stays at width 0 and transparent. If the chunk fails to load, the command is shown at rest and the failure is logged.

The kit's `useSpring` (`motionValue`, `attachSpring`) stays in the boot for the composer, and no kit patch was needed. Rollup tree-shakes a dynamic import only when the export is destructured. `import("motion").then(({ animate }) => animate)` gives a 44.4 kB raw, 14.2 kB brotli chunk. `import("motion").then((module) => module.animate)` kept motion's whole namespace: 115.5 kB raw, 33.6 kB brotli.

### 3. Plugin control frames without a stylesheet copy

`openFrame` serialized every CSS rule on the page (`appStylesheetText`) into each frame's boot message. That included the hidden control frame each bundled plugin boots on every signed web load. A control frame renders nothing, so the boot message now carries the stylesheet text only for a slot frame (`slot: { target, css }` in `FrameBoot`). A slot frame still serializes when it opens. Those frames open only for a live plugin's rendered page, settings section or overlay, so caching the text was not needed for the boot.

### 4. The settings dictionaries at their doors

The accounts, settings and usage English, 33 kB raw, was registered in `firstPartyDictionaries`, but nothing on the first screen reads it. Each domain now exports a loader. Three doors include those dictionaries before they draw:

- **The settings sidebar and page:** `SettingsTranslations`, fed by each section's `translations`.
- **The connect-machine drawer and the onboarding route:** `useTranslatedLazyView`, which loads the view and its dictionaries together.

`include(domains)` resolves once the current locale's strings are in, so a non-English reader sees no English first. `ShellBody` prefetches the dictionaries when the first screen settles. A `WithTranslations` at the root of the onboarding screen made Solid's `insertBefore` throw when it resolved, and the route stayed blank in the rig. The lazy view does not have that problem.

The 7.4 kB brotli is about 6 ms at 10 Mbps, which is inside the rig's spread.

## Measured and kept: the code views' prefetch

The session screen fetches the code views once its first page has painted (`loadCodeViews`). On dev's first session press, `worker-*.js` (123.4 kB on the wire) and the viewer chunks started 1 ms after the text and took 343 ms on the India profile. Without the prefetch, the first diff a person expands would wait those 343 ms plus evaluation. The prefetch costs nothing before text, because the session screen holds it until the first page has painted (`holdPrefetch`), so it stays.

## What is left, with its owner

- **The MCP App host's frame** (`mcp-apps/view/frame.tsx`, the bridge, bootstrap and requests, about 20 kB raw) is still in the boot. A lazy `McpAppFrame` would draw nothing between the part's document arriving and the chunk landing, unless the chunk starts loading while the part is pending. Owner: `src/mcp-apps`.
- **The plugin surface prefetch** fetches 62 kB brotli after every signed boot settles, whether or not the person opens the Tasks page. Prefetching on intent instead, when the pointer reaches a surface page's rail row or tab, would save it for those who never open one. Owner: `src/plugins`.
- **A slot frame still serializes the page's stylesheets when it opens** (about 14 ms unthrottled). Giving the frame its own stylesheet URL needs its `style-src` to allow the app's origin. Owner: `src/plugins/frame`.
