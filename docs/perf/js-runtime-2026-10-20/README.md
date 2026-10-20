# Main-thread JavaScript at runtime, 20 October 2026

Where the web app's main thread spends its time when a person boots it, opens and switches sessions, types, and watches a reply stream, measured on the signed e2e stack with the web perf rig, ranked by milliseconds, and what changed. Unthrottled on an M4 Pro the app is already quick (a return switch paints in 21 to 31 ms, a cold boot is 160 to 380 ms busy, a key reaches the screen in 5 ms). At 4x CPU, the mid-range laptop or phone a person in India is likely to have, two costs stand out: a cold boot and a streaming reply. The streaming reply also grew with its own length.

## How it was measured

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging --cpu=4 --long=1,8 --stream`, and again with `--cpu=1` and with `--stream=long-reply`. Each step records a Chromium trace and a sampled CPU profile (250 µs). The profiles are mapped through the build's hidden source maps and summed by function, inclusive and self, inside a step's window or one long task's window. Control and candidate are two builds of the same tree, served one after the other with `--dist` in alternating runs: the control is origin/dev `94f63ca666` with pristine dependencies, the candidate is this branch. The host is shared with three other lanes, at load 6 to 22. Two control runs of one build differed by up to 10% in a step's busy time, so a total is called a change only when the runs do not overlap. Smaller changes are attributed through the profile, which repeats within a few percent from run to run.

The rig gained three things for this work: every step's `.cpuprofile` is saved beside its trace, `--dist=<dir>` serves an existing build, and `--stream=long-reply` streams `longReplyScript` (every report segment twice, 16 characters per chunk, as one text part, which grows past a hundred Markdown blocks).

A scratch Playwright lab on the same stack streamed the report and the long reply with the trace and profile running. It measured the frames a stream produces, which rAF callbacks run them, and which composited layers repaint. It also tried each candidate below before a rig run.

## Ranked costs before (control, 4x CPU, india-staging, p50 of 3)

| flow | main thread busy | what it is, largest first |
|---|---|---|
| Streaming a reply (the report, 41 s) | 15.4 s, no task over 60 ms | Rendering about 7.5 s: paint 1.8, style 1.7, layout 1.4, prepaint 1.4, layerize 0.9, commit 0.5, hit testing 0.4. Script about 5.8 s, of which the per-frame delta commit is 3.5 s. Inside that commit, Markdown sanitize of the growing block is 0.9 s (DOMParser's parse 0.35 s), the live block's DOM update 0.84 s (its `innerHTML` 0.29 s, morphdom 0.4 s, decoration 0.1 s), lexing the tail 0.42 s plus `remend`'s heal 0.27 s, the virtualizer's resize and follow-scroll 0.43 s, and the Markdown resource's per-block walk 0.2 s. Frame intake from the event stream is 1.09 s and GC 0.8 s. 2,340 frames for about 1,530 delta commits: about 530 frames are the Markdown worker's highlight answers for code blocks, and about 200 are scroll events. |
| Streaming the long reply (41 s) | 22.0 s | As above, with three costs that grow with the reply. The follow-scroll's forced layout (`scrollTo` in `scrollToFn`, called from TanStack's at-end adjustment) is 1.6 s, because the growing row is laid out again on every frame. Paint is 4.0 s. The Markdown resource's walk over every finished block on every delta (`highlightCode`'s cache-key checksum, `blockHash`, `enhanceTextBlock`'s cache touch) is 0.66 s. |
| Cold boot of `/` to the rail | 742 ms, tasks of 219 and 210 ms | Lazy compilation of functions on first call, about 170 to 240 ms plus parsing. The main module's evaluation is 197 ms, of which 21 to 38 ms is ICU starting inside two vendored modules' top level (fixed below), 8 ms is marked's regexes, and 6 ms is zod. The shell's first render is about 100 ms of script, with the composer subtree 55 ms, the closed workspace panel's header and frame 29 ms, the rail 20 ms and icons 15 ms. About 300 ms after the rail paints, one 55 ms call to `appStylesheetText` (`src/plugins/frame/styles.ts`) serializes every CSS rule of the page for a plugin frame's boot, and `createSidePanelSettle`'s `getAnimations` forces a style and layout pass of 26 ms. |
| Cold boot of a session | 1,266 ms, three tasks of 215 to 233 ms | As above, plus the session's first render: about 270 ms, of which 110 ms is compiling the session view's code and the rest is the timeline, Markdown and the virtualizer's first measurement. |
| Warm reload | 629 ms | Producing V8's code cache for the second load of each script is 180 ms on that load. The shell renders in 94 ms and the session in 90 ms. |
| Opening a session from the rail | 313 to 494 ms | The press task (about 80 ms) mounts the session screen and composer. The first-fold task (about 80 ms) is the timeline at 43 ms plus the virtualizer's measurement at 22 ms, which is the new screen's first layout done early. The first session opened also compiles about 80 ms of session code. |
| Opening the 1 MiB session | 379 ms, task of 142 ms | Lexing every visible message's Markdown (marked, inline tokens included) is 63 ms of the first-fold task. |
| Returning to an open session | 110 to 140 ms, one task of 80 to 105 ms | Mostly the shown screen's style and layout, forced inside the click by the virtualizer's measurement. Script is under 10 ms. |
| Typing in the composer | key p50 7 to 8 ms, p95 13 to 14 ms, max 18 ms | No task over 50 ms. |
| Idle on an open session (20 s) | 13 ms | No frames and one timer. Nothing polls or animates on the main thread. |

Unthrottled, the same flows are 181 ms (cold root), 376 ms (cold session), 160 ms (warm reload), 28 to 35 ms (return switch) and 4.6 s over 41 s (the report) busy, with no long task.

## Changes

1. **A cold boot no longer starts ICU before anything formats** (`patches/@kobalte%2Fcore@0.13.12.patch`, `patches/@internationalized%2Fnumber@3.6.7.patch`). Kobalte's default locale validated the language tag with `Intl.DateTimeFormat.supportedLocalesOf` as its chunk evaluated. `@internationalized/number` probed two `de-DE` number formats at module evaluation. Whichever ran first paid ICU's start, 20 to 30 ms at 4x. Kobalte now validates with `Intl.getCanonicalLocales`, which throws for the same tags. The number probes run on their first use and keep their answers.
2. **A streaming reply re-renders only the blocks that changed since its last settled render** (`settledBlock` in `src/transcript/markdown-blocks.ts`). The Markdown resource's fetcher keeps its last successful result and returns a block unchanged when the new projection has the same key, mode and raw text at that index and the block is finished: a closed code block, or a text block in its final form. Before, every delta walked every block of the reply through the block cache and the highlight cache.
3. **The placement and account catalogs are read by their precomputed query hashes** (`src/server/merged-catalog.ts`, `src/server/account-placements.ts`). Every event frame asks `placementFor` for its directory, and each ask ran `getQueryData`'s option defaulting and key hashing for both catalogs.

## Before and after (control → candidate, india-staging)

4x CPU, p50 of 3 (the stream rows show all three runs):

| step | headline ms | busy ms | TBT ms | profile |
|---|---|---|---|---|
| cold-root/boot, rail | 1,497 / 1,411 → 1,385 / 1,354 (two pairs of two) | 914 / 821 → 792 / 764 | 442 / 381 → 366 / 350 | vendor UI top level plus `getDefaultLocale`: 21 to 38 → 2 to 6 ms in every cold boot; main module evaluation 241 / 201 → 201 / 191 |
| cold-session/boot, text | 2,364 / 2,427 → 2,359 / 2,387 | 1,429 / 1,483 → 1,436 / 1,463 | | same ICU saving; the rest is inside drift |
| onboarding/boot | 1,485 / 1,422 → 1,395 / 1,397 | 809 / 727 → 705 / 698 | | same |
| stream-turn/long-reply | 41.3 s end either way | 21,531 / 22,034 / 22,376 → 20,587 / 20,135 / 19,991 | 0 | script 9,216 / 9,328 / 9,527 → 8,393 / 8,093 / 8,028; delta commit 3.94 to 4.03 → 3.45 to 3.51 s; Markdown fetcher 1.75 to 1.80 → 1.16 to 1.23 s; frame intake 0.90 to 0.95 → 0.75 to 0.78 s; `placementFor` 154 → 34 ms |
| stream-turn/report | 41.1 to 41.3 s end | 15,378 / 16,005 / 14,615 → 15,430 / 15,446 / 15,082 | 0 to 4 | script 5,742 / 5,942 / 5,707 → 5,494 / 5,613 / 5,536 |
| switches, opens, typing, lazy pages | unchanged within drift | | | |

1x CPU, p50 of 3: cold root busy 181 → 163 ms, cold session 376 → 347 ms, onboarding boot 193 → 177 ms. Switches (25 to 41 ms), opens and typing (key p95 8.6 to 9.7 ms) are unchanged within drift. The report stream was 4.47 to 4.71 s busy against 4.56 and 4.75 s (one candidate run is the stall below), with script 1.54 to 1.61 s against 1.45 and 1.53 s.

## Tried and not kept

Each of these is a row in the [perf ledger](../AGENTS.md).

- **Explicit compile hints** (`//# allFunctionsCalledOnLoad` on the seven initial chunks) moved a cold boot's main-thread lazy compilation from 236 to 33 ms. Busy time did not fall, a cold session's text was 163 ms later, and a warm reload's code-cache production grew from 180 to 490 ms, 158 ms later to text, because the cache now holds every function.
- **Skipping the resize anchor's `scrollToEnd` when the virtualizer already sits at its end** cut forced layouts while streaming from 1,015 to 630 per run. Busy time and the frame count (2,335) did not move: that layout is the frame's own, done early.
- **`position: relative` on each top-level Markdown block**, so each block is its own paint layer and keeps its cached paint, left paint at 3.7 s on the long reply and made layerize slower (1.34 → 1.5 s).

## What is left, with its owner

- **The streaming follow layout** (`createTimelineResizeAnchor` and TanStack's at-end adjustment, `src/session/view/timeline/timeline-virtualization.ts`): 1.6 s of a long reply at 4x, growing with the row. A row that streams is laid out again on every frame because its measured height drives the virtual content's height. Containment inside the growing row is the open question.
- **The live block's sanitize and DOM update** (`syncBlock`, `updateBlock` in `src/transcript/markdown.tsx`): about 1.7 s of the report at 4x, proportional to the live block's size. The ledger's condition for retrying a parse-free sanitizer still holds.
- **`appStylesheetText`** (`src/plugins/frame/styles.ts`, from the MCP App host): 55 ms at 4x, about 14 ms unthrottled, for each plugin frame boot. It reads `cssText` from every rule of the page's stylesheets. One frame boots about 300 ms after the rail paints on a cold boot. The plugin host's owner could pass the same-origin sheet URLs, or cache the text per sheet, instead of serializing the page's CSS on the main thread.
- **Code-block highlight frames**: each delta inside a streaming code block costs two frames, the commit and the worker's answer, about 9 ms at 4x together against 8 ms for a prose delta.
- **Boot compile and evaluation**: about 400 ms of a cold boot at 4x is V8 compiling and evaluating the initial chunks. Only less eager JavaScript reduces it (the bundle lane's work); compile hints did not.
- **A report stream that stops mid-paragraph**: in two of nine unthrottled stream runs, one on dev `7ad7d58d0b` and one on this branch, the report stopped after the Mermaid diagram, mid-sentence ("The diagram step 1 re"), and never finished. One run showed the composer idle; the other showed the turn still working ("Thinking"). It never happened at 4x CPU. The rig's screenshots are kept in its output directory. Whether the agent's stream or the app stalled was not diagnosed.
