# What the boot downloads and runs, 20 October 2026

A signed boot of the web app downloads its scripts and stylesheets before it can draw the rail: on the rig's india-staging profile (10 Mbps down) the boot's 537 kB of brotli in the first wave finished arriving 705 ms into the navigation and the rail painted about 130 ms later. Bytes in that wave are the boot's critical path, about 0.8 ms per kB. This note inventories what is in those bytes, how much of it the first screen runs, which build settings and chunk boundaries were measured, and the one change that moved: the web build no longer forces packages into named vendor chunks.

## How it was measured

- Bytes: the cloud web build (`vite.cloud.config.ts`) of dev `7ad7d58d0b`, brotli 11 and gzip 6 per file, attributed to source modules through each chunk's hidden source map (`analyzeDist`, `packages/claxedo-app/e2e/perf/web/bytes.ts`). Attribution is by mapping segment, so a few kB at module boundaries land on a neighbour (the kit's `context/helper.tsx`, 1.9 kB of source, is credited with 18.5).
- Execution: `bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=1 --profile=none --coverage`, which this branch adds. JavaScript is the bytes of each chunk inside functions the boot ran (V8 block coverage, started before the navigation, taken when the step settles). Module-level tables count as run, since their module ran. A stylesheet's used bytes are its rules whose selector, without interactive pseudo-classes and pseudo-elements, matches an element once the step settles. The rig's Chromium reports every rule inside an `@layer` with the whole layer's offsets through `CSS.startRuleUsageTracking`, so the protocol cannot tell which layered rule ran.
- Time: `bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=3 --profile=india-staging` (100 ms to static, 300 ms to the API, 10 Mbps down, the e2e front over HTTP/2), dev in one worktree and this branch in another, run back to back between 18:30 and 18:41 UTC. The host was shared with other lanes' suites (load 12–18, 0.2 GiB free during the base run).

## Inventory at dev 7ad7d58d0b

The shell document's first wave: nine files, 2,404.5 kB raw, 686.3 kB gzip, 564.3 kB brotli.

| asset | raw kB | br kB | ran at cold root | ran at cold session |
|---|---|---|---|---|
| `main.js` | 1,294.7 | 306.4 | 39% | 45% |
| `main.css` | 367.0 | 44.6 | 30% | 35% |
| `vendor-ui.js` (Kobalte 125.8, motion-dom 55.6, `@solidjs/router` 13.2, Floating UI 18.8) | 232.7 | 59.5 | 13% | 13% |
| `preferences.js` (shared with the signed-out document: icon record 47.0, theme 50, auth 19.7, artwork 20) | 208.6 | 46.2 | 84% | 85% |
| `vendor-markdown.js` (marked 41.6, dompurify 28.7, `property-information` 18.1, remend 11.4, `hast-util-to-html` 7.9) | 118.9 | 34.5 | 45% | 56% |
| `vendor-query.js` (query-core 33.3, virtual-core 22.7) | 59.0 | 15.7 | 26% | 51% |
| `vendor-solid.js` | 50.8 | 16.7 | 56% | 59% |
| `vendor-better-auth.js` | 26.3 | 8.3 | 36% | 36% |
| `preferences.css` (the sign-in form's sheets) | 9.6 | 4.0 | 1% | 1% |

`main.js` by domain (raw kB, share run at the cold session): composer 197.7 (39%), transcript 184.6 (43%), session 180.5 (46%), server adapter 147.2 (30%), rail 58.2, shell 49.6, plugins 37.2 (20%), workbench 33.3, projects 30.3, `account-contract`'s hosted operations table 23.2, panel 21.9, accounts 21.6. English dictionaries of every domain are 131.8 kB of it, loaded before the shell renders by design (`src/i18n/README.md`); the settings-only ones (accounts 19.2, tasks 10.3, settings 8.4, usage 5.6) are about 44 kB. The largest unexecuted modules at the cold session are `transcript/message-part.tsx` (31.2 of 36.9 kB), `claxedo-tasks/src/decode.ts` (11.1 of 11.1, the tasks client the server adapter builds at start), `message-timeline.tsx` (10.2 of 23.8), `markdown.tsx` (7.9 of 14.0) and the tool renderers: code for parts and tools the seeded sessions do not show, which real sessions do.

`main.css` by layer (re-serialized rule bytes, cold session): components 148.3 kB with 31 matched, unlayered component sheets 138.3 with 38, utilities 60.7 with 18, theme tokens 46.1 with 40. Every one of the 837 custom properties is read somewhere in the shipped CSS or JavaScript (the theme resolver lists them for the other themes), 39 utilities (2.7 kB) are named by no shipped file, and of the sheets `src/styles.css` imports, only the kit's `popover.css` and `resize-handle.css` and the transcript's `file.css` (4.4 kB of source) style classes that no boot chunk names. The unmatched rules are the dialogs, menus, docks, tool rows and review views a session shows later, so the sheet holds little that a person never sees.

After first text the session screen prefetches the code views (`loadCodeViews`): a shared `worker-*.js` of 532.5 kB raw, 114 kB brotli, of which `@pierre/diffs` is 334.4 kB and shiki's main-thread highlighter about 150, and 10% runs before the reader opens a diff.

Duplicate packages: only `diff`, 9.0.0 under `@pierre/diffs` and 8.0.3 in the app's `session-diff` chunk, both lazy. No development build of a library ships (`solid-js/dist/solid.js`, `web.js`, `store.js`), the bundles hold no `process.env`, `import.meta`, `console.log` or `console.debug`, and only English is in the boot: every `locales/<code>.ts` is its own `locale-<code>` chunk.

## The change: no forced vendor chunks

`vendor-solid`, `vendor-ui`, `vendor-query`, `vendor-markdown`, `vendor-toast` and the account binding's `vendor-better-auth` were `manualChunks` by package. A vendor chunk is imported by the entry, so every module of its packages downloaded with the first screen, also those only lazily loaded code uses: Kobalte's select, tabs, radio group and switch for the settings pages (about 35 kB raw) and the hast serializer with `property-information` and the entity tables (about 30 kB), which only the diff viewer's shiki output reads. Rollup now places each module with the chunks that use it, and `manualChunks` keeps only the locale grouping.

The split had been kept so a returning browser would keep the vendors across a deploy that left them alone. Rollup's minified internal export names follow the app's imports, so that did not hold: built from `d946b7939c` and `7ad7d58d0b`, two dev commits with one lockfile, `vendor-solid`, `vendor-ui`, `vendor-query` and `vendor-toast` carry identical code under new hashes because their `export{…}` lines name the bindings differently.

| first wave | dev `7ad7d58d0b` | this branch |
|---|---|---|
| shell document | 9 files, 2,404.5 kB raw, 564.3 kB br | 4 files, 2,334.5 kB raw, 542.6 kB br |
| of it JavaScript | 7 files, 1,991.0 raw, 487.3 br | 2 files (`main` 396.6 br, `preferences` 69.0), 1,921.5 raw, 465.6 br |
| signed-out document | 6 files, 84.4 kB br | 4 files, 82.2 kB br |

Measured, p50 of 3 (milliseconds; requests, kB on the wire, dependency waves):

| step | headline before → after | fcp | requests | kB | main-thread busy |
|---|---|---|---|---|---|
| cold-root/boot, rail | 834 → 859 | 876 → 900 | 41 → 36 | 644.7 → 621.8 | 179 → 223 |
| cold-session/boot, session text | 1,730 → 1,711 | 868 → 856 | 54 → 49 | 794.1 → 780.1 | 348 → 341 |
| warm-session/reload, session text | 587 → 576 | 384 → 384 | 53 → 48 | 57.4 → 57.0 | 161 → 149 |
| open-session/press, session text | 491 → 452 | | 7 → 7 | 18.4 → 18.3 | 95 → 80 |
| first-session/press, session text | 515 → 549 | | 19 → 19 | 179.6 → 188.5 | 150 → 172 |
| lazy-pages/settings | 14 → 13 | | 6 → 6 | 24.8 → 24.7 | |
| lazy-pages/marketplace | 356 → 359 | | 8 → 8 | 32.4 → 33.3 | |
| signed-out-login/boot, form | 390 → 382 | 400 → 392 | 10 → 8 | 153.0 → 150.4 | 61 → 58 |
| onboarding/boot | 1,072 → 1,032 | 1,032 → 1,024 | 61 → 56 | 721.7 → 705.9 | 211 → 205 |

The bytes move the network rows: the first wave's last byte arrives 696 ms into a cold session instead of 708 (median), five fewer requests, 22 kB less on the wire. The headlines move within the run-to-run spread of this shared host: the branch's three cold-root boots were 859, 871 and 807 ms with 232, 223 and 166 ms of main-thread work, against 834, 827 and 850 with 170 to 189, so the cold root's median rose with the host's load, not the bytes (rule 21 in [AGENTS.md](../AGENTS.md)). `v8.evaluateModule` for the cold root was 41–44 ms before and 38–53 after; one 1.6 MB `main` compiles on the streaming parser as it arrives, as seven files did.

## Measured and not taken

| setting | result |
|---|---|
| minifier for the boot's JavaScript (unminified build, the seven boot chunks) | terser two-pass, current: 1,990,305 raw / 486,977 br in 6.2 s; terser with `ecma: 2020`: 486,476 br; three passes: 486,490; oxc-minify 0.95: 1,985,318 / 491,651 in 0.14 s; esbuild 0.25: 2,020,802 / 508,968. Terser stays. |
| `build.target` | already `esnext`; the build injects no module-preload polyfill. |
| `build.cssMinify: "lightningcss"` | `main.css` 367,046 → 365,938 raw, 44,595 → 44,256 br. |
| `output.experimentalMinChunkSize: 8000` | 504 → 471 JavaScript files, and 6.8 kB br more in the boot, merged in from lazy chunks. |
| keeping vendor chunks for modules an entry imports statically | no byte moves: every Kobalte module is reachable from the entry through some import edge, used or not, so `importedIds` cannot tell a lazy-only module. |
| the auth routes (`/login`, `/invitations`, `/device`, `/oauth/consent`) as lazy views in the shell | 9.1 kB br and the `preferences.css` request off the signed boot; the signed-out document gains three requests and 0.7 kB, and an expired session's `/login` in the shell would draw nothing for a round trip, since the shell has no loading frame for a screen route. Not taken. |
| the session pane's screen as a lazy view | no byte moves: the transcript and timeline are reached from the draft screen, the composer and the rail as well. |

## What is left, with its owner

- The English dictionaries the shell loads before rendering (131.8 kB raw, about 44 of it for settings-only domains): `src/i18n` and `src/registry.ts`; a domain's English would have to load with its view without a flash of keys.
- motion's `animate` (most of motion-dom's 55.6 kB) runs only when a tool row expands (`transcript/basic-tool.tsx`, `shell-tool.tsx`), while the composer's toolbar needs only `motionValue` and `attachSpring`: the transcript's and the kit's owners.
- The tasks client (`claxedo-tasks/src/decode.ts`, 11.1 kB, never run at boot), built eagerly by `createTasksApi` in `src/server/tasks.ts`.
- The code views' 114 kB brotli after first text, two thirds of it `@pierre/diffs` and its main-thread shiki, which the package imports itself.
- The OpenCode icon record (47 kB raw) shares the boot with the Codex sprite; [AGENTS.md](../AGENTS.md) records its earlier removal and why it was reverted.
