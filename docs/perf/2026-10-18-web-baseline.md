# Web app baseline, 18 October 2026

This is what a person waits for on the signed web app at dev `8b2d1e949b`, measured by `bun run e2e:perf-web` (the rig in `packages/claxedo-app/e2e/perf/web/`, described in [the app's e2e guide](../../packages/claxedo-app/e2e/README.md#performance-the-web-app-as-a-person-meets-it)). Every cost below is ranked by the milliseconds it adds to the wait, named by its owner file, and handed to a lane. A second column shows dev `79cf281121`, the tip after the asset-delivery, CSS/sprite, boot-waterfall and request-latency lanes merged, measured by the same rig in the same hour.

## How it was measured

The rig drives headless Chromium 1228 (Playwright 1.61) over CDP against the signed e2e stack: the hosted Worker on Miniflare, the relay on workerd, and a local daemon enrolled as the owner's machine, all on loopback. The app is served the way Cloudflare Pages serves it, from the build's own `_headers`: at `8b2d1e949b` every response carried `no-transform`, which Pages honours by not compressing, so the bytes below are the bytes staging shipped; at `79cf281121` `/assets/*` compresses (brotli 11 here, Cloudflare's own level on staging) while the shell still carries `no-transform`. Hashed assets are immutable, the shell revalidates with an ETag.

Two network profiles run in turn. `fast` adds 20 ms before every response and caps throughput at 100 Mbps. `india-staging` adds 100 ms to every static response and 300 ms to every control-plane and relay answer (the Worker's extra 200 ms is added by the front, since Chromium's emulation cannot delay one origin more than another) and caps the link at 10 Mbps down, 5 up. Chromium's emulation adds its latency once per request before headers can arrive; it does not replay a handshake per round trip, and the local stack serves the app and the API from one origin, so the production API's own TLS handshake (one connect and one TLS round trip on the first API call, about 600 ms at 300 ms RTT) is not in these numbers.

Each repetition runs every scenario once in three contexts at 1440×900, device scale 2: a cold boot of `/` to the rail; one context for a cold boot of the newest session's route, its warm reload, a press on the second session's rail row, a 34-character line typed into the composer, four return switches, the Marketplace and Settings pages; a cold signed-out boot of `/` to the login form. The rail holds two sessions of 12 scripted turns above eight one-turn sessions. Three repetitions; every cell is the median; a run's waterfall is the repetition whose headline sat at the median. "Session text" is the painted frame that first showed assistant text in the destination's transcript, with no loading placeholder; "two screens" is the frame at which the transcript held two viewports of content, the owner's "done"; "settled" is four stable frames after that.

The control plane's request budgets were lifted for the rig (600 requests a minute per client at the Worker and at its shared rate-limit binding, 120 on control routes, 6 workspace connections a minute per person and workspace), since three repetitions boot the app fifteen times a minute. The host was a shared 12-core M4 Pro with 24 GB under other agents' builds: load average 12–30 during the `8b2d1e949b` run (10:09–10:13 UTC) and 16–24 during the `79cf281121` run (10:14–10:17 UTC), 4–7 GB free. CPU-bound rows (main-thread totals, long tasks) carry that noise; the network rows are set by the profile and repeat within a few percent.

## Headline

Milliseconds from the navigation's time origin (boots) or from the trusted press (interactions). `kB` is what the browser received on the wire.

| scenario | profile | `8b2d1e949b` | `79cf281121` | what the number is |
|---|---|---|---|---|
| cold boot of `/` | fast | 647 | 340 | rail filled |
| cold boot of `/` | india-staging | 4,399 | 1,565 | rail filled |
| cold boot of a session | fast | 755 | 486 | session text (two screens at the same frame; settled 799 / 529) |
| cold boot of a session | india-staging | 5,324 | 2,797 | session text (settled 5,343 / 2,815) |
| first contentful paint, cold session | india-staging | 4,244 | 1,604 | nothing paints before `main.js` has run |
| largest contentful paint, cold session | india-staging | 5,356 (`pre`) | 2,815 | the transcript's code block |
| bytes on the wire, cold session | both | 4,448 kB over 39 requests | 951 kB over 37 | |
| warm reload of a session | fast | 233 | 233 | session text |
| warm reload of a session | india-staging | 982 | 943 | session text; 311 kB / 70 kB on the wire |
| open the second session from the rail | fast | 77 | 83 | press to session text |
| open the second session from the rail | india-staging | 704 | 667 | press to session text |
| return switch (median of four) | both | 24–27 | 25–28 | press to session text; settled 31–39 |
| typing in the composer | both | 5–6 / 9 / 10 | 5–6 / 9 / 10 | keydown to painted character, p50 / p95 / max over 35 keys |
| Marketplace from the rail | fast / india | 98 / 384 | 100 / 356 | press to first plugin card |
| Settings from the account menu | both | 10 | 11–12 | press to the settings page; no chunk loads |
| signed-out `/` | fast | 551 | 279 | login form |
| signed-out `/` | india-staging | 3,940 | 1,252 | login form; 4,490 kB / 993 kB on the wire |
| main thread busy, cold session | fast / india | 293 / 409 ms | 269 / 389 ms | `RunTask` total in the window |
| total blocking time, cold session | fast / india | 15 / 11 ms | 10 / 32 ms | two long tasks of 50–67 ms, both `RunMicrotasks` |

## The cold boot of a session, step by step (india-staging, `8b2d1e949b`)

The document answers after 150 ms (111 ms of it the round trip). The parser meets `oc-theme-preload.js`, a synchronous script in `<head>`, and waits 110 ms for it before it discovers `main.js`, `vendor-solid`, `vendor-better-auth` and `main.css`, all requested at 263 ms. `main.js` is 3,646,914 bytes on the wire, uncompressed, and takes 3,412 ms, 3,301 of them download at 10 Mbps; `main.css` is 405,283 bytes and takes 817 ms beside it. Nothing paints until `main.js` has run: the shell, the composer and the rail's frame appear at 4,223 ms, first contentful paint at 4,244.

Module evaluation sends the first API requests 49 ms after the download ends (3,724 ms): `/api/claxedo/auth/descriptor`, `/api/claxedo/bootstrap` and `/api/auth/get-session`, each answered after one 207 ms round trip, plus `codex-BgVqJb5Z.js`, the Codex theme's palette, a 7.6 kB lazy import on the boot path. `get-session` gates the next wave at 3,949 ms: `/api/claxedo/bootstrap` again, `/api/workspace?host=provisioner`, `/api/workspace?host=machine` and `/api/workspace/shared-sessions`, 215 ms. Those gate the third wave at 4,166–4,221 ms: the `/api/cp/events` stream (a first attempt at 3,935 ms was abandoned after 15 ms), `remote-access/devices`, the 270 kB icon sprite (uncompressed, 347 ms), the workspace `connection`, `agent-config/connections` and `session-list`, 212 ms. Only then, at 4,410 ms, do the session reads leave: `outline?rows=41`, `?view=open`, `queue`, `pty` and two `events` streams to the relay. Each carries `Authorization: Bearer`, so each is preceded by a CORS preflight of 205 ms, and the reads' own answers take a further 632 ms (300 ms round trip, the rest the relay room and the daemon). The first text paints at 5,324 ms, two screens of it in the same frame; the same `outline` and `?view=open` reads are sent a second time at 5,317 ms, and `config-options` (617 ms) follows for the composer.

So the wait divides into: 3,412 ms for `main.js`, 110 ms for the theme preload ahead of it, 150 ms for the document, 686 ms for three serial API waves before a session read can start, 205 ms of preflight, 632 ms for the first read, and about 50 ms of script between download and first request. Main-thread work in the whole window is 384 ms busy out of 5,343 (TBT 11 ms); the CSS parses in 1.6 ms. At `79cf281121` the same boot reaches text at 2,797 ms: `main.js` compressed to 802,212 bytes takes 809 ms, the theme preload is inline so `main.js` is requested at 168 ms, `main.css` is 50 kB, the sprite 29 kB, `?host=machine` is gone and the first session pages ride with `session-list`; the three API waves, the preflights and the 714–774 ms session reads remain and are now 60% of the wait.

The warm reload (india, 982 ms) takes every asset from memory cache, revalidates the shell (112 ms) and the theme preload (a 304, 110 ms, still serial), then pays the same API waves: descriptor, bootstrap, workspaces and `get-session` at 239–457 ms, `session-list`, `remote-access`, `agent-config` and the sprite (270 kB again, 332 ms, its cache-control is the shell's) at 457–700 ms, and the session reads at 499 ms with 420–443 ms answers; preflights are absent because Chromium still holds the ones from the cold boot. Opening the second session from the rail (india, 704 ms) is one preflight (203 ms) and one read (465 ms); a return switch is 24–27 ms of pure rendering, two requests of 15 kB.

## Bytes

Initial assets of `8b2d1e949b`, as built (`vite.cloud.config.ts`): 11 files, 4,160 kB raw, 1,153 kB gzip, 909 kB brotli; the build also holds 787 lazy JS and CSS chunks, 21,924 kB raw. At `8b2d1e949b` staging sent the raw column; at `79cf281121` it sends the brotli column for `/assets/*` and the raw 3.9 kB shell.

| asset | raw kB | gzip kB | br kB | on the wire at `8b2d1e949b` |
|---|---|---|---|---|
| `main-3GX-l__i.js` | 3,646.6 | 1,028.1 | 801.5 | 3,646.9 |
| `main-DxAFG80u.css` | 405.0 | 69.3 | 54.3 | 405.3 |
| `vendor-solid-Bsi2Nm8-.js` | 46.9 | 17.3 | 15.8 | 47.2 |
| `vendor-better-auth-Df-WQM2c.js` | 26.1 | 9.6 | 8.7 | 26.4 |
| `favicon-v3.ico` (requested twice on a cold boot) | 15.1 | 15.1 | 15.1 | 15.4 ×2 |
| `index.html` | 2.8 | 1.1 | 0.8 | 3.0 |
| `oc-theme-preload.js` | 1.9 | 0.9 | 0.7 | 2.2 |
| fetched by script at boot: `sprite-CKnd50EP.svg` | 269.9 | — | 71.4 | 270.2 |
| imported by script at boot: `codex-BgVqJb5Z.js` (the Codex theme) | 7.3 | — | 1.7 | 7.6 |
| `markdown-shiki.worker-BGMyyL94.js` (worker, after first text) | — | — | — | from cache |

Generated bytes of `main.js` by source, from its hidden source map (top of 3,647 kB): `@pierre/diffs` 409.7 kB, `@kobalte/core` 121.7, `zod` 71.5, `motion-dom` 57.1, `ui/src/components/icon.tsx` 47.1 (the OpenCode icon record), `@shikijs/vscode-textmate` 42.6, `marked` 41.7, `src/transcript/message-part.tsx` 37.6, `solid-sonner` 36.6, `@tanstack/query-core` 33.7, `shiki` 33.0, `dompurify` 29.8, `oniguruma-to-es` 26.8, `message-timeline.tsx` 24.9, `oniguruma-parser` 24.0, `account-contract/src/hosted-operations.ts` 23.1, `@tanstack/virtual-core` 22.7, `@shikijs/core` 19.7, `ui/src/context/helper.tsx` 18.5, `property-information` 18.2, `src/accounts/locales/en.ts` 17.5, `src/transcript/markdown-inline-code-kind.ts` 16.6, `ui/src/theme/resolve.ts` 15.7, `ui/src/components/file-icons/types.ts` 14.8, `ui/src/i18n/en.ts` 14.2, `markdown.tsx` 14.1, `@pierre/theming` 13.9, `src/accounts/locales/fr.ts` 13.6, `@solidjs/router` 13.6, `@shikijs/primitive` 13.6. The diff renderer, the syntax highlighter's grammar engine, Zod, the toast and motion libraries, and the French dictionary are all in the chunk every visitor downloads, including the signed-out login page. The Settings page loads no chunk at all when opened, so it is in there too; the Marketplace page loads `marketplace-page` (58 kB wire) and `claxedo-logo` (1.3 kB).

## Main thread

Cold session, fast, `8b2d1e949b`, window 799 ms: `RunTask` 282 ms, of which `RunMicrotasks` 155, `ParseHTML` 28, `UpdateLayoutTree` 17, `Layout` 15, `FunctionCall` 12, `V8.CompileCode` 11 (lazy function compiles), `Paint` 6, `EvaluateScript` 4, `ParseAuthorStyleSheet` 1.7; two long tasks (61 ms at 565 ms, 54 ms at 678 ms), both `RunMicrotasks`, the promise resolution after API answers. The CPU profile samples 101 ms of self time in `main.js` and 63 ms in `vendor-solid` for the window; the heaviest frames are `requestAnimationFrame` scheduling (10–16 ms), `querySelector` (7–9 ms), `@tanstack/virtual-core` `measureElement` from `src/session/view/timeline/timeline-virtualization.ts:21` (6–9 ms), `@kobalte/core` `getDefaultLocale` (4 ms), `dompurify` sanitising from `src/transcript/markdown-cache.tsx:38` (3–6 ms), `@tanstack/query-core` `scheduleGc` timers (6–8 ms). `main.js` is compiled off the main thread by the streaming parser (3.2 ms on it); its evaluation shows no URL in the trace and is what the sampled `main.js` self time names. The india window is the same work spread over 5.3 s. Typing: 35 keys, p50 5 ms, p95 9 ms, max 10 ms; the top frame is `updateDraft` in `src/composer/store.ts:85` through `src/composer/deferred-persistence.ts:24` (6.8 ms over the line).

## Every measured cost, ranked by the milliseconds it adds to the wait

The wait is the india-staging cold boot of a session at `8b2d1e949b`, 5,324 ms to first text, unless a row says otherwise; the `79cf281121` figure follows where the lane has already moved it.

| # | cost | ms | owner | lane |
|---|---|---|---|---|
| 1 | `main.js` sent uncompressed: 3,647 kB on the wire, 3,301 ms of download at 10 Mbps | 3,301 (now 704 compressed) | `packages/claxedo-app/public/_headers` (`no-transform` on `/assets/*`) | asset-delivery |
| 2 | `main.js` itself: 3,647 kB raw / 802 kB brotli, 704 ms to download even compressed, and nothing paints before it runs (FCP 4,244 / 1,604) | 704 remaining | `packages/claxedo-app/vite.cloud.config.ts` (one `main` chunk; `manualChunks` names only `vendor-solid` and the auth adapter) | initial-js |
| 3 | three serial control-plane waves between `main.js` and the first session read: `get-session` → workspace catalog → `connection` and `session-list` | 686 (now 749: 1,026 → 1,776) | `packages/claxedo-app/src/server/workspaces.ts` (`catalogReads`, `createWorkspaces`), `src/auth/browser-auth.ts`, `src/server/transport.ts:71` | boot-waterfall |
| 4 | the first session read's answer: 632 ms for `outline?rows=41` once sent (300 round trip + the relay room and daemon) | 632 (now 714–774) | `packages/claxedo-app/src/server/session-reads.ts` (`startSessionReads`), relay `packages/workspace-relay` | pi-durable |
| 5 | `main.css` 405 kB uncompressed, 817 ms beside `main.js` (parallel, but shares the 10 Mbps) | 817 of bandwidth (now 212, 50 kB) | `packages/ui/src/styles/tailwind/colors.css` (287 custom properties), `packages/claxedo-app/src/styles.ts` | css-sprite |
| 6 | a CORS preflight before every relay request, 205 ms each, six at once before the first read | 205 (per URL, still paid on a cold boot) | `packages/claxedo-app/src/server/relay.ts:56` (`Authorization: Bearer` makes the request non-simple); relay CORS in `packages/workspace-relay` | session-open |
| 7 | `oc-theme-preload.js` as a synchronous head script: the parser waits 110 ms before it discovers `main.js` | 110 (now 0, inlined) | `packages/claxedo-app/index.html`, `public/oc-theme-preload.js` | boot-waterfall |
| 8 | the document's own round trip, 150 ms with no preconnect to the API or relay yet | 150 (preconnect added) | `packages/claxedo-app/index.html` | boot-waterfall |
| 9 | the session reads repeated as the first text paints: `outline?rows=41` and `?view=open` again at 5,317 ms, 423–427 ms each | 0 to text, 430 to settle and to the composer | `packages/claxedo-app/src/session/transcript/snapshot.ts` (`readSnapshot` / `readOnce`), `src/server/session-reads.ts` | session-open |
| 10 | `config-options` to the relay after text: preflight + 417 ms, before the composer knows the harness | 617 after text (now 731) | `packages/claxedo-app/src/server/harness-options.ts:66`, `src/composer/harness/config-options-probe.ts` | session-open |
| 11 | `/api/claxedo/bootstrap` read twice at boot (wave 1 and wave 2) | one request | `packages/claxedo-app/src/server/workspaces.ts:229` (`read` and `reread`) | boot-waterfall |
| 12 | the icon sprite, 270 kB uncompressed, fetched by script at 4,194 ms beside the session reads | 347 of bandwidth (now 133, 29 kB) | `packages/ui/src/components/icon.tsx` (`ensureSprite`), `src/ui/icons/codex.ts` | css-sprite |
| 13 | `codex-BgVqJb5Z.js`, the Codex theme's palette as a 7.6 kB lazy chunk imported during boot, one static round trip | 116 (parallel) | `packages/ui/src/theme/themes/codex.json`, loaded by `packages/ui/src/theme/resolve.ts` | initial-js |
| 14 | `/api/cp/events` opened, abandoned after 15 ms, reopened 230 ms later; signed out it is a 401 | 0 to text; one wasted request | `packages/claxedo-app/src/server/streams.ts:112` | boot-waterfall |
| 15 | module evaluation between the end of `main.js` and the first API request | 49 (fast: 62) | `packages/claxedo-app/src/main.tsx`, `src/app.tsx` | main-thread |
| 16 | `/api/workspace?host=machine`, `?host=provisioner` and `shared-sessions` as three reads in wave 2 | 0 beyond the wave (now two) | `packages/claxedo-app/src/server/cloud.ts:21`, `src/server/shared-sessions.ts` | boot-waterfall |
| 17 | `session-list` and `connection` only after the catalog: the rail's rows arrive at 4,434 ms, 210 ms after the shell | 210 to the rail | `packages/claxedo-app/src/server/session-list.ts:62`, `src/server/transport.ts:99` | boot-waterfall |
| 18 | the warm reload still revalidates the theme preload serially (304, 110 ms) and the shell (112 ms) | 222 of the 982 warm boot | `packages/claxedo-app/index.html` | boot-waterfall |
| 19 | the warm reload re-fetches the 270 kB sprite: its cache-control is the shell's `max-age=0` | 332 of the warm boot's bandwidth | `packages/claxedo-app/public/_headers`, `packages/ui/src/components/icon.tsx` | css-sprite |
| 20 | opening a session from the rail: one preflight and one relay read, 203 + 465 | 704 (now 667) | `packages/claxedo-app/src/server/session-reads.ts`, relay | session-open |
| 21 | long tasks: 58 ms and 52 ms of `RunMicrotasks` when the catalog and the session reads answer | 11 TBT (fast 15) | `packages/claxedo-app/src/server/transport.ts`, `src/session/transcript/snapshot.ts` | main-thread |
| 22 | style and layout in the cold window: `UpdateLayoutTree` 27, `Layout` 15, `Paint` 5, stylesheet parse 1.6 | 49 (spread) | `packages/claxedo-app/src/session/view/timeline/message-timeline.tsx` | main-thread |
| 23 | `@tanstack/virtual-core` `measureElement` on every row mount | 6–9 sampled | `packages/claxedo-app/src/session/view/timeline/timeline-virtualization.ts:21` | main-thread |
| 24 | `dompurify` sanitising every markdown part on first render | 3–6 sampled | `packages/claxedo-app/src/transcript/markdown-cache.tsx:38` | main-thread |
| 25 | `@tanstack/query-core` `scheduleGc` / `clearGcTimeout` timers on every query settle | 6–8 sampled | `packages/claxedo-app/src/server/fetch-query.ts` | main-thread |
| 26 | the signed-out login page downloads the whole app: 4,490 kB, 3,940 ms to a form (now 993 kB, 1,252 ms), and opens `/api/cp/events` for a 401 | 3,940 (now 1,252) | `packages/claxedo-app/src/auth/view/login.tsx`, `src/app.tsx` | initial-js |
| 27 | the Settings page is in the eager chunk (opens in 10 ms, loads nothing) | bytes in #2 | `packages/claxedo-app/src/shell/view/settings-page.tsx`, `src/settings` | initial-js |
| 28 | the cold boot of `/` opens the workspace panel's `git/status`, `pty` and `events` through the relay after the rail: three preflights and 817–831 ms answers | after the rail | `packages/claxedo-app/src/server/git.ts`, `src/server/wire/terminals.ts` | pi-durable |
| 29 | Marketplace from the rail: `marketplace-page` 58 kB + `claxedo-logo` chunks and `/api/claxedo/plugins` + `/sources`, 6 requests | 98 fast / 384 india | `packages/claxedo-app/src/marketplace/view/marketplace-page.tsx`, `src/server/marketplace.ts:23` | initial-js |
| 30 | six workspace connections a minute per person and workspace: a seventh reload in a minute answers "Too many requests" and the app stops at the error card | a failed boot | `packages/claxedo-server/src/authority/provider-neutral-hosted-services.ts:94`, `src/routes/hosted/workspace.ts:205` | unowned |

Not ranked, measured: the favicon is requested twice on a cold boot (15 kB each, uncompressed); the shell is 3.9 kB at `79cf281121` because `/*` still carries `no-transform`; return switches are 24–28 ms and need no lane; typing is under 10 ms at the 95th percentile.

## What the rig could not measure

- The production API's separate origin: its DNS, TCP and TLS handshakes before the first API call (two round trips, about 600 ms at 300 ms RTT, once per page) are absent, since the local stack answers the app and the API from one origin. The `--target` mode against staging with an exported cookie file measures them; it was not run here because the rig never signs in to staging itself.
- Cloudflare's own compression level and edge cache hits: the local front sends brotli 11 for compressible assets; Cloudflare compresses on the fly at a lower level, so staging's compressed bytes are a few percent larger than the brotli column.
- A real client's CPU: the host was shared and loaded; main-thread totals carry 10–20% noise and are reported as medians of three. `--cpu=4` exists and was not used.
- Pi durable sessions: the seeded sessions run the scripted ACP harness on the enrolled machine, so the relay path measured is the machine's, not a session Durable Object's; the pi-durable lane's own rig measures that.

## Reproduction

```sh
CLAXEDO_E2E_PORT_RANGE=48300-48399 bun run --cwd packages/claxedo-app e2e:perf-web -- --reps=3 --label=dev-8b2d1e9 --out=/tmp/web-perf/8b2d1e9
bun run --cwd packages/claxedo-app e2e:perf-web -- --target=https://app.claxedo.dev --cookies=/path/to/cookies.json --profile=none --reps=3 --label=staging --out=/tmp/web-perf/staging
```

Each run takes about four minutes including the stack's start (26–60 s on this host) and writes `<label>-summary.md` and `<label>-summary.json` beside one trace per step; the figures above come from `dev-8b2d1e9-summary.json` and `dev-79cf281-summary.json`.
