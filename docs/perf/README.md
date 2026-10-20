# Making Claxedo lighter

The perf harness that owned the commands and measurement contracts was deleted at the app swap. The current measurement tool is `bun run e2e:perf-stream`, described in [the app's e2e guide](../../packages/claxedo-app/e2e/README.md#performance-a-streaming-turn). The narrative below records earlier product work.

In August 2026 we tried to make Claxedo feel light. The product is a coding-agent workbench that ships as a signed web app and a packaged Electron desktop. Both were heavy in ways that were easy to feel and hard to name: a long first download, a slow first session, a desktop that sat well above a gigabyte, a switch between two already-open chats that rebuilt the world.

This is not the experiment log. Hundreds of agents ran packaged builds, ablations, and false wins. Most of that work was thrown away. What follows is what actually changed, and what we learned about making a workbench like this cheaper to hold.

Agents looking for what we already tried — and should not try again without a new reason — should read [AGENTS.md](./AGENTS.md).
The web app's measured baseline at dev `8b2d1e949b`, every cost ranked with its owner and lane, is [2026-10-18-web-baseline.md](./2026-10-18-web-baseline.md); `bun run e2e:perf-web` reproduces it.
The serial D1 rounds a signed control-plane read pays, what one costs on staging and where the databases run, is [d1-signed-reads-2026-10-18](./d1-signed-reads-2026-10-18/README.md).
Serving the API and the relay from the app's own origin, so a boot sends no CORS preflight and opens one connection, is measured and its deploy steps listed in [2026-10-18-web-one-origin.md](./2026-10-18-web-one-origin.md).
How often a control-plane request from India lands on a cold isolate, what the 0.5 s it then pays is made of, and the composition that was rebuilt on a quarter of warm requests until its readiness ran under `waitUntil`, is [worker-cold-starts-2026-10-19](./worker-cold-starts-2026-10-19/README.md).
A signed-out visitor's first page, the sign-in form, served as its own document by the edge from the cookie alone (945 ms and 656 kB to 361 ms and 153 kB at 100 ms RTT), and the build change that keeps a second entry's graph to what it uses, is [signed-out-document-2026-10-20](./signed-out-document-2026-10-20/README.md).
The hosted onboarding's four steps measured under the India profile, the reads each waited on in series and the two that moved off the path (the Where step's read leaving with the wizard's chunk, the Project step reading nothing, each finish refresh one round), is [onboarding-steps-2026-10-20](./onboarding-steps-2026-10-20/README.md).
A reload's session reads leaving on the tab's kept relay link as the main chunk runs, and the shell's startup frame painting with the document (warm reload text 796 to 569 ms, a cold boot's first paint 500 to 176 ms), with what bounds both now, is [reload-paint-2026-10-20](./reload-paint-2026-10-20/README.md).
Every request the sign-in, provider connect windows and AI-provider and sandbox-key setup make, the serial rounds each waited on before and after, the `upstream` Server-Timing that names the vendor a slow request waited on, and how to capture a staging trace, is [server-requests-2026-10-20](./server-requests-2026-10-20/README.md).
A signed request admitted on the principal a live verification of its session cookie produced in the last 60 s, carried in a signed cookie, so it pays no verification round (shared-sessions 3 → 1 D1 rounds, `auth` 76–168 ms on staging before), why Better Auth's own cookie cache and an isolate-memory cache were not used, and the staging measurement snippet, is [session-cache-2026-10-20](./session-cache-2026-10-20/README.md).
Where the web app's main thread spends its time per flow at 4x and 1x CPU, ranked by milliseconds; ICU no longer starting during a cold boot's module evaluation; a streaming reply re-rendering only its changed Markdown blocks (a long reply's script 9.3 to 8.2 s at 4x); and what is left with its owner, is [js-runtime-2026-10-20](./js-runtime-2026-10-20/README.md).
How soon each sandbox driver notices its host is up, Boat's readiness taken from the command Boat holds until the sandbox is ready and its runtime's health probed inside the machine (a Boat start settling 1.4–1.6 s sooner on average, half the Boat requests), and a provisioner step that is itself a wait followed at once, is [provisioning-wait-2026-10-21](./provisioning-wait-2026-10-21/README.md).
What the signed boot downloads and runs, chunk by chunk and module by module (the rig's new `--coverage`), the build settings measured against it, and the web build's vendor chunks given up because they pulled lazily used Kobalte and hast modules into the first wave (seven boot scripts of 526.2 kB brotli to two of 509.8 on dev `94f63ca666`), and zod back in the boot with the A2UI surfaces, is [bundle-build-2026-10-20](./bundle-build-2026-10-20/README.md).
The account-port bench is the `desktop/account-port` entry in the performance-tools catalog; the write-up of its numbers was retired with the other one-off perf notes.

## The weight was not one thing

Three surfaces, three different kinds of fat.

**The web app** downloaded 2.6 MB of JavaScript before first paint. Diff rendering, syntax highlighting, the AI client, KaTeX, settings, onboarding, and a 252 kB copy of Zod were all sitting on the eager path. The repo already had a forbidden-eager-deps guard. It was failing.

**The embedded engine** that answers `/provider` on desktop boot was a 23 MB artifact with the models.dev catalog inlined. Importing it took about 1.4 s and about 280 MiB of RSS in the server child before the app had opened a session.

**The renderer** treated a session switch as a cold mount. The app-shell's only Suspense detached the entire DOM. The workbench store applied every reducer as a wholesale node replacement. Markdown highlighting lived in a per-component map, so remounting a chat re-paid a 50 ms worker round trip for code the user had already seen.

Electron's own processes — main, GPU, network utility — plus the server child already used about 740 MiB of summed RSS at first snapshot, before any session work. A 650 MiB peak-RSS target was impossible on this topology. Peak RSS also cannot reward a process that exits later: moving the engine into a worker that idles out added 130 MiB and 129 ms, because the peak had already happened.

That last sentence is the whole accounting lesson. An earlier idle-memory campaign measured the same disposable child as a large **win** in native physical footprint (the pressure-oriented macOS number, closer to Activity Monitor). The later campaign measured it as a large **loss** in peak process-family RSS. Both numbers were real. They are not the same unit, and merging them is how you ship a process that looks idle-cheap and measures peak-expensive.

## Download less

The web work was mostly about lazy boundaries that already existed on paper.

We cut the session-kit fan-out so the eager composer no longer pulled Pierre and Shiki through a barrel. We stopped re-exporting settings, routes, dialogs, and the terminal from the entry. We evicted Zod from the boot graph with plain predicates at the seams. We deduped two full copies of KaTeX. We replaced Luxon at three call sites with `Intl`. We made the forbidden-eager-deps walker able to see through `session-ui`, which is how three of the five leaked packages had been invisible.

A hash-safe `modulepreload` of the four boot chunks removed about a second of serial discovery at 40 ms RTT. KaTeX CSS and its font faces left the render-blocking stylesheet for the lazy math chunk.

The eager main chunk went from 2,585 kB (748 kB gzip) to about 940 kB (286 kB gzip). CSS dropped from 475 kB to 417 kB.

Diagrams draw with pele instead of mermaid.js, on the web and on the desktop, which no longer packages a native Mermaid helper. A first flowchart fetches about 53 kB gzip of renderer instead of 219 kB, a diagram renders in 0.2–3.1 ms instead of one 17–168 ms task (Chromium, 1x CPU, 26 diagrams), and the web build ships 2.7 MB (0.67 MB gzip) less JavaScript.

The remaining eager cost is real product: session UI, Kobalte, the API client, the English fallback dictionary, and the icon record used to build a sprite at runtime.

## Start less

The desktop's cold path was bound by the engine import, not by how much of the provider catalogue we returned. The app already asked `view=index`. The initializer still ran in full.

What moved:

- Minify the shipped engine artifact (the CLI build already was; the packaged one was not) and de-inline the 3.7 MB catalog to a sibling JSON file read lazily. Import dropped about 267 ms and 37 MiB of RSS. The artifact went from 23 MB to 10 MB plus that sibling.
- Drop sqlite page-cache ceilings from 64 MiB to 8 MiB on both databases.
- Stop reading 37 migration SQL files on a warm boot. Gate `repair()` on a sqlite_master fingerprint.
- Lazy-load the provider `database` object. Serve the already-built catalog from the handler instead of rebuilding it.
- Bound third-party plugin construction at 1 s so an uncached network fetch in someone else's `~/.config` cannot wedge boot for 5 s.
- Minify Electron main, preload, and renderer — the presets default off. Exclude node-pty's Windows PDBs and node-gyp trees. One PTY module (`@lydell/node-pty`) instead of two. That last change is about 33 MB off the Windows download.

The hosted control plane Worker had the same problem on Cloudflare. Its full-hosted bundle was 10,953 KiB in 2,650 modules, and Cloudflare reported its startup at 167–297 ms over the five staging deploys before 2026-10-18; the session-host Worker, half the size, reported 20–23 ms. Cloudflare's startup time is the parse and execution of the global scope ([Worker limits](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time)), and a cold start also fetches and compiles the script before the first request runs ([shard and conquer](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)). Four things were in it that no request needed: the Pi launch catalog constructed Pi's providers, which carry the OpenAI, Anthropic and Google SDKs, when it only reads their model tables; Wrangler resolved the `zod/v4` alias to zod's CommonJS build, a second zod with every locale; the MCP SDK built its protocol schemas at startup in isolates that never serve MCP; and `@opentelemetry/semantic-conventions` arrived as its untreeshakable CommonJS build. Without them the bundle is 7,396 KiB in 1,513 modules, a cold workerd isolate is ready in about 160 ms instead of 270 on an M4 Pro, and under Node the script compiles in 58 ms instead of 82 and evaluates in 51 instead of 76. Cloudflare prints the deployed startup time as `Worker Startup Time` in the deploy log, and every response's `Server-Timing` carries `cold` on an isolate's first request and `compose` on the request that built the control plane.

A plugin-init budget does not reclaim the 350–400 ms a well-behaved plugin still spends on boot. Reclaiming that needs lazy construction per harness, which we did not build. Isolation of the operator's global OpenCode config is a measurement pin, not a product fix: it takes the plugin out of the number, not out of the user's machine.

## Keep less

Idle cost was not one leak. It was product that did not belong on the unsigned desktop, caps that did not run, and caps on the wrong dimension.

The single largest idle-memory move was compositional: the optional hosted features default-off, lazy, and absent from the unsigned desktop. That dropped restored-state native footprint from about 643 MiB to 465 MiB. The local/hosted package split that followed is structural prevention for the same idea — unsigned startup cannot import hosted auth, sandboxes, Relay, or those features — and it gets no inferred MiB credit as a package move. The measured saving was turning the features off, not relocating the folders.

Around that:

- Bound the server child's V8 heap before isolate creation (`--expose-gc --optimize-for-size --max-old-space-size=512`). About 154 MiB of native footprint.
- Mount only the visible non-terminal surface. Hidden terminals keep their live PTY. About 38 MiB.
- Run the process-metrics helper only while Diagnostics has subscribers. About 24 MiB, and it removes a whole idle helper process.
- Cap the workbench at ten retained surfaces. Compact the provider index and fetch detail on demand. Persist queries asynchronously and expire inactive ones.
- Compact PTY disk history with a hard UTF-8 cap; quiescent CPU on that path went from hundreds of percent to about 4%.

Session shell caches then had a count limit with zero callers — a written policy that never evicted. Wiring it was not enough: forty heavy transcripts at about 2 kB per tool-call message is still about 1.6 GB with every count ceiling green. A 128 MiB byte budget now runs beside the count, in two passes (count first, then weight), deferred to idle so sizing a 20k-message transcript cannot stall a switch.

Completed markdown highlights live in a module-scope LRU, byte-capped, keyed by content. A remount is a cache hit. Large code blocks above a token limit stay copyable text instead of eleven thousand token spans.

Diff workers and Pierre virtualizers are disclosure-owned: they exist for an open file and go away when it closes. Nested diffs use a 240 px buffer, not Pierre's 1,000 px default. Large views drop word-diff above 500 KB. OpenCode icons inject one sprite and render `<use>`; that is 36–38% faster warm than per-instance inline paths. DOM-node count barely moved, so the win is render cost, not memory.

Hidden windows pause the 10 s wake detector and the 20 s health poll.

Count caps still do not bound terminal scrollback globally (5,000 lines per terminal), and a split workbench can hold more live surfaces than `MAX_OPEN_SURFACES` because mounted panes are exempt. The query cache is still time-bounded, not byte-bounded: evicting a `ChatClient` deliberately leaves its transcript in the cache, which is correct for reopen and is why a count on clients cannot be the memory ceiling.

## Rebuild less

The largest interaction win was not a faster render. It was not tearing the tree down.

The app-shell Suspense remounted the entire DOM on every session switch. Pane-local Suspense plus restore-first offset reconnect took switch completion from about 2.5 s / 1.6 s down to about 600 ms and cut renderer tasks in the window from tens of thousands to about a thousand.

The workbench store then stopped replacing every pane node on `navigation.show`. Production had drifted from its own test harness, which already used `reconcile`. Rail rows stopped rebuilding wholesale; they read through lazy accessors.

Boot stopped fetching the provider catalog, workspace resolve, and a handful of other endpoints twice. About 51 boot requests became 39.

Streaming no longer re-ran row construction for every turn on every part delta. It leans on the projection's WeakMap identity, pinned by a tripwire test.

The transcript itself has one product invariant, paid for in packaged Electron rather than in the browser lane: **one message has one canonical renderer.** Virtualization may decide whether an offscreen row exists. Progressive work may defer highlighting or Mermaid inside a stable row. It must not replace a visible message with a plain-text preview and then with Markdown, or jump the viewport to the first turn when cached history backfills. Those two bugs shipped in experiment packages that had already passed headless browser tests. The four-turn initial history window is the rendering basis; shrinking it to one turn over a 10k-message history made the switch 181 ms p95.

While looking for speed we also found two product defects: the main composer model picker showed one model per connected provider, and a saved non-default model selection silently failed validation at boot. Both were already load-bearing bugs. Performance work is a good way to trip them.

## What we stopped believing

Reducing total work does not make the measured window cheaper. Seven candidates died that way: they were real, they were measured, and they did not move the interaction they were aimed at.

A control is a build measured in the same session, never a remembered number. The one published win we had to retract — a rail clock that supposedly saved 10 ms — was baseline drift. Same-tree A/B later gave 0.1 ms.

Hiding unused surfaces with `content-visibility: hidden` saved 55 MiB and cost streaming and history. A snapshot-and-reveal LRU made warm switch and history both worse. Compiling a server helper to native with `scriptc` used 95% less RSS and took 2.3× as long. Preloading the engine on the server thread is arithmetically zero-sum: `/provider` got faster by exactly as much as readiness got slower. Disposing OpenCode state inside the long-lived server does not unload it; process exit is the boundary. Native Markdown and Mermaid helpers added disk and did not move idle footprint. Cutting the icon catalog out of the main chunk made the chunk smaller and left the 22 ms module-evaluation task in place. Lazy-loading signed auth UI did the same — the graph that actually held launch was shared local/remote event transport. Splitting feature-port wiring into serial graphs removed a miss class and added 74 ms of completion.

The original "five times faster" gate set was also the wrong conversation for some of its own numbers. Warm switch was measuring a cold mount twenty times out of twenty. Stream interaction is quantized to 8 ms. Quiescent CPU's least count is 1 percentage point — 20% of its own budget. LCP and CLS on synthetically clicked flows were measuring the harness: untrusted clicks never freeze LCP and never excuse the layout shift the click asked for.

A metric can be perfectly repeatable and still measure the instrument.

## What that left

Claxedo is lighter to download, cheaper to start, and several times cheaper to switch. It is not 5× the original arithmetic target, and it cannot be 650 MiB of peak process-family RSS on Electron as we ship it.

The work that survived is the kind you keep even if no gate moves: a plugin that cannot hang boot, a model picker that shows the models you actually have, a catalogue that an empty response cannot clobber, a highlight you don't re-pay, a session cache that actually evicts.

The rest — the attempts that failed, and the conditions under which they would be worth trying again — is in [AGENTS.md](./AGENTS.md).
