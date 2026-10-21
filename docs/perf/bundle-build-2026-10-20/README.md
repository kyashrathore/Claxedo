# What the boot downloads and runs, 20 October 2026

A signed boot of the web app downloads its scripts and stylesheets before it can draw the rail: on the rig's india-staging profile (10 Mbps down) the first wave's 581 kB of brotli finished arriving about 740 ms into the navigation, and the rail painted about 115 ms later. Bytes in that wave are the boot's critical path, about 0.8 ms per kB. This note inventories what is in those bytes, how much of it the first screen runs, which build settings and chunk boundaries were measured, and the one change that moved: the web build no longer forces packages into named vendor chunks.

## How it was measured

- Bytes: the cloud web build (`vite.cloud.config.ts`) of dev `0cdc7ed4e4`, brotli 11 and gzip 6 per file, attributed to source modules through each chunk's hidden source map (`analyzeDist`, `packages/claxedo-app/e2e/perf/web/bytes.ts`). Attribution is by mapping segment, so a few kB at module boundaries land on a neighbour (the kit's `context/helper.tsx`, 1.9 kB of source, is credited with 18.5).
- Execution: `bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=1 --profile=none --coverage`, which this branch adds. JavaScript is the bytes of each chunk inside functions the boot ran (V8 block coverage, started before the navigation, taken when the step settles); module-level tables count as run, since their module ran. A stylesheet's used bytes are its rules whose selector, without interactive pseudo-classes and pseudo-elements, matches an element once the step settles. The rig's Chromium reports every rule inside an `@layer` with the whole layer's offsets through `CSS.startRuleUsageTracking`, so the protocol cannot tell which layered rule ran.
- Time: `bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=3 --profile=india-staging` (100 ms to static, 300 ms to the API, 10 Mbps down, the e2e front over HTTP/2), dev `0cdc7ed4e4` in one worktree and this branch in another, back to back, 22:06–22:11 UTC on 20 October. The host was shared with other lanes' suites, at load 12–15 through both runs.

## Inventory at dev 0cdc7ed4e4

The shell document's first wave is nine scripts and stylesheets: 2,596 kB raw, 581 kB brotli.

| asset | raw kB | br kB | ran at cold root | ran at cold session |
|---|---|---|---|---|
| `main.js` | 1,461.9 | 344.6 | 38% | 43% |
| `main.css` | 422.5 | 50.0 | 27% | 31% |
| `vendor-ui.js` (Kobalte, motion-dom, `@solidjs/router`, Floating UI) | 239.1 | 60.9 | 12% | 12% |
| `preferences.js` (shared with the signed-out document: icon record 47.0, theme about 50, auth 19.7, artwork about 20) | 208.8 | 46.2 | 84% | 85% |
| `vendor-markdown.js` (marked 41.6, dompurify 28.7, `property-information` 18.1, remend 11.4, `hast-util-to-html` 7.9) | 118.9 | 34.5 | 45% | 56% |
| `vendor-query.js` (query-core, virtual-core) | 57.8 | 15.4 | 27% | 52% |
| `vendor-solid.js` | 50.8 | 16.7 | 56% | 59% |
| `vendor-better-auth.js` | 26.3 | 8.3 | 36% | 36% |
| `preferences.css` (the sign-in form's sheets) | 9.6 | 4.0 | 1% | 1% |

In all, the cold root ran or matched 1,158 of the 2,866 kB of JavaScript and CSS it loaded (40%), the cold session 1,347 of 3,568 (38%).

`main.js` by source (raw kB, share run at the cold session): composer 204.0 (39%), transcript 183.6 (42%), session 180.9 (46%), server adapter 147.9 (30%), zod 73.0 (31%), the A2UI surfaces (`src/surface`) 58.5 (22%), rail 58.2, shell 50.4, plugins 44.6 (38%), workbench 33.3, projects 30.4, the MCP App host (`src/mcp-apps`) 23.0 (32%), panel 21.9, accounts 21.6, `account-contract`'s hosted operations table 19.9. English dictionaries are about 123 kB of it, loaded before the shell renders by design (`src/i18n/README.md`); the settings-only ones (accounts, settings, usage) are about 33. The largest unexecuted modules at the cold session are `transcript/message-part.tsx` (29.0 of 34.6 kB), `message-timeline.tsx` (10.1 of 23.8), `markdown.tsx` (7.9 of 14.0) and the tool renderers: code for parts and tools the seeded sessions do not show, which real sessions do.

Zod is back in the boot. The surfaces' A2UI catalog (`@claxedo/plugin-api`'s `surface/catalog.ts`) builds its zod schemas at module scope, and the app reaches it for a constant (`SURFACE_ICON_NAMES`, through `src/surface/icon-names.ts`); the plugin API's `transcript.ts` does the same for the first-party plugins' tool-card templates, which `src/plugins/bindings/transcript.ts` validates with `readToolCardTemplates` at registration. With the surfaces, the MCP App host and the plugin-api surface modules, that is about 167 kB raw of the boot, of which about 50 runs.

`main.css` (dev `7ad7d58d0b`, re-serialized rule bytes at the cold session): components layer 148.3 kB with 31 matched, unlayered component sheets 138.3 with 38, utilities 60.7 with 18, theme tokens 46.1 with 40. Every one of the 837 custom properties is read somewhere in the shipped CSS or JavaScript (the theme resolver lists them for the other themes), 39 utilities (2.7 kB) are named by no shipped file, and of the sheets `src/styles.css` imports only the kit's `popover.css` and `resize-handle.css` and the transcript's `file.css` (4.4 kB of source) style classes that no boot chunk names. The unmatched rules are the dialogs, menus, docks, tool rows and review views a session shows later, so the sheet holds little that a person never sees.

After first text the session screen prefetches the code views (`loadCodeViews`): a shared `worker-*.js` of 532.5 kB raw, 114 kB brotli, of which `@pierre/diffs` is 334.4 kB and shiki's main-thread highlighter about 150, and 10% runs before the reader opens a diff.

Duplicate packages: only `diff`, 9.0.0 under `@pierre/diffs` and 8.0.3 in the app's `session-diff` chunk, both lazy. No development build of a library ships (`solid-js/dist/solid.js`, `web.js`, `store.js`), the bundles hold no `process.env`, `import.meta`, `console.log` or `console.debug`, and only English is in the boot: every `locales/<code>.ts` is its own `locale-<code>` chunk.

## The change: no forced vendor chunks

`vendor-solid`, `vendor-ui`, `vendor-query`, `vendor-markdown`, `vendor-toast` and the account binding's `vendor-better-auth` were `manualChunks` by package. A vendor chunk is imported by the entry, so every module of its packages downloaded with the first screen, also those only lazily loaded code uses: Kobalte's select, tabs, radio group and switch for the settings pages (about 35 kB raw) and the hast serializer with `property-information` and the entity tables (about 30 kB), which only the diff viewer's shiki output reads. Rollup now places each module with the chunks that use it, and `manualChunks` keeps only the locale grouping.

The split had been kept so a returning browser would keep the vendors across a deploy that left them alone. Rollup's minified internal export names follow the app's imports, so that did not hold: built from `d946b7939c` and `7ad7d58d0b`, two dev commits with one lockfile, `vendor-solid`, `vendor-ui`, `vendor-query` and `vendor-toast` carry identical code under new hashes because their `export{…}` lines name the bindings differently; between `94f63ca666` and `0cdc7ed4e4` `vendor-ui` changed hash again with the Kobalte patch.

| first wave | dev `0cdc7ed4e4` | this branch |
|---|---|---|
| shell document, scripts and stylesheets | 9 files, 2,595.7 kB raw, 580.6 kB br | 4 files, 2,562.9 kB raw, 563.8 kB br |
| of it JavaScript | 7 files, 2,163.6 raw, 526.6 br | 2 files (`main` 440.7 br, `preferences` 69.1), 2,130.8 raw, 509.8 br |
| signed-out document | 6 files, 84.5 kB br | 4 files, 82.2 kB br |

On dev `7ad7d58d0b`, before PR #59's surfaces, the same change took the boot's JavaScript from 487.3 to 465.6 kB brotli.

Measured, p50 of 3 (milliseconds; requests and kB on the wire; main-thread busy ms; when the main chunk's last byte arrived):

| step | headline before → after | fcp | requests | kB | busy | main chunk done |
|---|---|---|---|---|---|---|
| cold-root/boot, rail | 861 → 836 | 896 → 872 | 42 → 37 | 875.8 → 857.7 | 161 → 154 | 745 → 722 |
| cold-session/boot, session text | 1,737 → 1,721 | 880 → 868 | 55 → 50 | 1,025.2 → 1,016.2 | 319 → 316 | 732 → 724 |
| warm-session/reload, session text | 581 → 576 | 372 → 376 | 54 → 49 | 212.6 → 212.2 | 146 → 141 | |
| first-session/press, session text | 490 → 485 | | 19 → 19 | 179.6 → 188.7 | 126 → 126 | |
| open-session/press, session text | 449 → 446 | | 7 → 7 | 18.3 → 18.3 | 71 → 75 | |
| lazy-pages/settings | 11 → 11 | | 6 → 6 | 24.8 → 24.7 | 11 → 11 | |
| lazy-pages/marketplace | 353 → 354 | | 6 → 6 | 31.2 → 31.0 | 46 → 46 | |
| signed-out-login/boot, form | 360 → 365 | 376 → 376 | 10 → 8 | 153.2 → 150.6 | 47 → 46 | 260 → 262 |
| onboarding/boot | 1,051 → 1,028 | 1,044 → 1,012 | 59 → 54 | 793.5 → 775.5 | 164 → 158 | 737 → 711 |

Every signed cold boot sends five fewer requests and receives 9 to 18 kB less, its main chunk is in 8 to 26 ms earlier, and its rail, text and first contentful paint follow by 12 to 32 ms, about what 17 kB at 10 Mbps buys plus the four requests' headers; main-thread work and `v8.evaluateModule` (42 and 40 ms at the cold root) are unchanged, so one 1.8 MB `main` compiles on the streaming parser as it arrives, as seven files did. Interactions inside a loaded page do not move, as nothing they load changed but the lazy chunks Kobalte's settings controls and the hast serializer now sit in. The signed-out form moves inside its spread (360, 369, 359 against 368, 362, 365): its document loads 2.3 kB less in two fewer files, and the shared chunk it waits on is larger by the solid-js and Better Auth it used to fetch beside it. Two earlier pairs on `7ad7d58d0b` and `94f63ca666`, run while the host's load differed by up to twice between the two arms, left the headlines inside the spread with the same bytes and requests (rule 21 in [AGENTS.md](../AGENTS.md)).

## Measured and not taken

| setting | result |
|---|---|
| minifier for the boot's JavaScript (unminified build of `7ad7d58d0b`, the seven boot chunks) | terser two-pass, current: 1,990,305 raw / 486,977 br in 6.2 s; terser with `ecma: 2020`: 486,476 br; three passes: 486,490; oxc-minify 0.95: 1,985,318 / 491,651 in 0.14 s; esbuild 0.25: 2,020,802 / 508,968. Terser stays. |
| `build.target` | already `esnext`; the build injects no module-preload polyfill. |
| `build.cssMinify: "lightningcss"` | `main.css` 367,046 → 365,938 raw, 44,595 → 44,256 br. |
| `output.experimentalMinChunkSize: 8000` | 504 → 471 JavaScript files, and 6.8 kB br more in the boot, merged in from lazy chunks. |
| keeping vendor chunks for modules an entry imports statically | no byte moves: every Kobalte module is reachable from the entry through some import edge, used or not, so `importedIds` cannot tell a lazy-only module. |
| the auth routes (`/login`, `/invitations`, `/device`, `/oauth/consent`) as lazy views in the shell | 9.1 kB br and the `preferences.css` request off the signed boot; the signed-out document gains three requests and 0.7 kB, and an expired session's `/login` in the shell would draw nothing for a round trip, since the shell has no loading frame for a screen route. Not taken. |
| the session pane's screen as a lazy view | no byte moves: the transcript and timeline are reached from the draft screen, the composer and the rail as well. |

## What is left, with its owner

The first four items below (zod and the surfaces, the settings-only dictionaries, motion's `animate` and the code views' prefetch) were taken up by the boot-bytes lane, measured in [boot-bytes-2026-10-21](../boot-bytes-2026-10-21/README.md).

- Zod and the A2UI catalog at boot (about 167 kB raw with the surfaces and the MCP App host, 50 of it run): the plugin API's `surface/catalog.ts` and `transcript.ts` build schemas at module scope, and the app imports the catalog for its icon names and validates first-party tool-card templates at registration. A zod-free module for the icon names and the plugin domain's choice of where first-party templates are checked would let both leave; owner: `@claxedo/plugin-api` and `src/plugins`, `src/surface`.
- The English dictionaries the shell loads before rendering (123.0 kB raw, about 33 of it for settings-only domains): `src/i18n` and `src/registry.ts`; a domain's English would have to load with its view without a flash of keys.
- motion's `animate` (most of motion-dom's 55.6 kB) runs only when a tool row expands (`transcript/basic-tool.tsx`, `shell-tool.tsx`), while the composer's toolbar needs only `motionValue` and `attachSpring`: the transcript's and the kit's owners.
- The code views' 114 kB brotli after first text, two thirds of it `@pierre/diffs` and its main-thread shiki, which the package imports itself.
- The OpenCode icon record (47 kB raw) shares the boot with the Codex sprite; [AGENTS.md](../AGENTS.md) records its earlier removal and why it was reverted.
