# U8 dependency decision: TanStack Virtual, Shiki, and Pierre

**Decision date:** 2026-08-09  
**Repository snapshot:** `daa87446e4a22ceaa6eed2e407bf970ddd420f04` plus the in-progress U3/U6/U7 working-tree changes present during the audit  
**Scope:** U8 from `docs/plans/2026-08-09-001-five-times-faster-than-t3-plan.md`  
**Constraint:** read-only spike. No source, manifest, patch, or lockfile was changed. Measurements of alternate versions were made in temporary projects outside the repository.

## Decision

| Dependency | Installed | Latest compatible checked | Selected path | Kill decision |
|---|---:|---:|---|---|
| TanStack Solid Virtual / core | `3.13.32` / `3.17.3`, with the repository's core patch | `3.13.36` / `3.17.7` | **Advance `3.13.36` / `3.17.7` with a semantic port of the existing clamp patch.** This is the only dependency change U8 should implement. | Kill unpatched `3.17.7`: it fails the oversized initial-offset/padding regression. Retire `3.17.3` only after the patched latest version passes the real timeline gates below. |
| Shiki / stream | `4.2.0` / `4.2.0` | `4.4.2` / `4.4.2` | **Keep `4.2.0` and the Oniguruma/WASM engine.** | Kill `4.4.2` for this performance program; kill the JavaScript regex engine for interactive highlighting; do not reduce the supported grammar set in U8. |
| Pierre Diffs | `1.2.10` | `1.3.5` | **Keep `1.2.10`; keep the local disclosure-owned metadata, virtualizer, and worker leases.** | Kill `1.3.5` for U8: compatible, but no parse win in an interleaved run and a larger retained/bundle boundary. Kill a local Pierre fork and a single mutable worker pool. |

The resulting dependency set is deliberately mixed: patched latest TanStack, current Shiki, current Pierre. Pierre accepts Shiki `^3 || ^4`, so there is no peer conflict. All exact pins should remain exact.

## Current runtime flow and authoritative hot paths

### A. Session timeline → TanStack Virtual

1. `MessageTimeline` creates the list virtualizer in `packages/claxedo-app/src/features/session/ui/message-timeline.tsx:830`.
2. It restores a stable measurement snapshot (`initialMeasurementsCache`, line 842), estimates only the last 50 rich rows precisely (lines 843–856), uses `anchorTo: "end"` and `followOnAppend` (lines 870–875), and retains 64 px end padding (line 878).
3. The local resize owner is `createTimelineResizeAnchor()` in `packages/claxedo-app/src/features/session/ui/timeline-virtualization.ts:33`. It pins visible rows around very large size changes, overrides `shouldAdjustScrollPositionOnItemSizeChange`, and re-anchors the bottom in a microtask (lines 46–85).
4. Disconnect/reconnect offset recovery and first-rect deduplication are app policy in `message-timeline-observe-offset.ts:3-100`, not reasons to fork the adapter.
5. On cleanup the timeline stores `virtualizer.takeSnapshot()` in a bounded 16-session cache (`message-timeline.tsx:1080-1084`).
6. The only upstream patch is `patches/@tanstack%2Fvirtual-core@3.17.3.patch`: clamp `calculateRange`'s effective offset to the reachable range and make `paddingEnd` a memo dependency. That patch is required by `message-timeline-virtualizer.test.ts:32-52`.

### B. Markdown code → Shiki

1. `Markdown` checks names against `bundledLanguages` and calls `highlightStreamingCode()` (`packages/session-ui/src/components/markdown.tsx:21,81-94`). A failure returns escaped plain tokens, so dependency failure already has a readable fallback.
2. `markdown-worker.ts:66-138` creates the worker only on first highlight, caps retained worker state, terminates on worker failure, and uses an 8 MiB token-state budget.
3. `markdown-shiki.worker.ts:29-87` constructs one highlighter with no grammars, loads the requested bundled grammar lazily, streams incomplete blocks through `ShikiStreamTokenizer`, and uses `codeToTokens` for complete blocks.
4. The working tree's U6 changes also prioritize visible work and bound queued bytes. These local queue/cache owners are higher-leverage than a Shiki fork.

### C. Disclosure/review → Pierre

1. `loadFileComponent()` dynamically imports the file surface and theme (`packages/claxedo-app/src/ui/session-kit-loaders.ts:3-8`).
2. Inline edit/apply-patch bodies create metadata only inside disclosed content; for example `message-part.tsx:2664-2703` resolves the patch inside `FrameDeferred`. Per-file apply-patch bodies are gated by disclosure at lines 2904-2919.
3. Review rows keep summary metadata cheap and resolve/release `normalize(source)` only for a mounted open file (`packages/session-ui/src/components/session-review.tsx:185-201,404-418`).
4. Pierre virtualizers are shared per owning scroll surface and per variant in `packages/session-ui/src/pierre/virtualizer.ts:16-118`. Inline diffs use a 240 px buffer rather than Pierre's 1,000 px default (lines 61-66), and the final lease cleans the virtualizer.
5. The working tree's `packages/session-ui/src/pierre/worker.ts:31-76` now owns disclosure leases and terminates a style pool after its last release. `file.tsx:1088-1090` acquires that lease only for a live viewer. Split and unified pools remain distinct because Pierre's `lineDiffType` is pool-global (`setRenderOptions`), not task-local; sharing one mutable pool would race concurrent split/unified viewers or require removing word diffs.
6. `session-diff.ts:27-90` bounds parsed metadata by encoded bytes rather than entry count. Large views also disable word diff/tokenization above 500 KB (`file.tsx:1025-1041`).

## Compatibility and upstream delta

### TanStack

- `@tanstack/solid-virtual@3.13.36` retains the `solid-js ^1.3.0` peer and points to `virtual-core@3.17.7`. The Solid adapter tarball is byte-identical in size to `3.13.32`; the core grows 15,634 unpacked bytes.
- A strict TypeScript API smoke using every locally consumed symbol and option (`Virtualizer`, `createVirtualizer`, `anchorTo`, `followOnAppend`, `takeSnapshot`, observers and scrolling helpers) passes against both versions.
- `3.17.5-3.17.7` contain end-anchor/iOS fixes, viewport-spanning streaming-row handling, and same-paint resize notification. These are directly relevant to a chat list. The app's custom resize predicate means the real browser fixture remains the authority; the core microbenchmark is supporting evidence only.
- Upstream `3.17.7` does **not** contain the repository's range clamp. The existing patch does not apply textually due to upstream drift, but a semantic port is five generated/source files and passed the two focused behavior tests in the temporary project.

### Shiki

- `4.4.2` keeps the same root and stream APIs, requires Node 20+ (the repository uses Node 22/Bun), and passes the strict API smoke. Upstream describes grammar/theme updates plus token-split optimization.
- The repository override would move `shiki`, `@shikijs/types`, and `@shikijs/transformers` together. Pierre's Shiki range remains compatible.
- The latest full lazy grammar closure adds 28 emitted chunks in the synthetic build. Fine-grained registration is technically compatible only if Claxedo intentionally stops recognizing all other bundled grammars; current code recognizes the entire registry, so an eight-language allowlist is a product regression rather than an optimization.

### Pierre

- `1.3.5` keeps all locally used vanilla, SSR, worker, virtualization, selection, and parse APIs; the full strict API smoke passes with Shiki held at `4.2.0`.
- Its release raises the Firefox floor from 120 to 125 and changes some SSR/vanilla prop types from interfaces to unions. Current uses compile, and Electron 43 is not affected, but the hosted browser support floor is still an external contract.
- `1.3.x` stabilizes virtualization and fixes a worker startup race, metadata updates, recycled-row content, reset spacers, and layout thrash. It also adds the separate edit subsystem. Claxedo does not use the editor or partial-diff hydration.
- The package tarball grows from 5,561,611 to 6,926,401 unpacked bytes (+1,364,790; +24.5%). It also changes its private `diff` dependency from 8.0.3 to 9.0.0, so it does not deduplicate the app's catalog `diff@8.0.2`.

## Measurements

All timing figures are medians of fresh Bun 1.3.14 processes on this host. They are narrow dependency measurements, not Chromium paint claims.

### Focused current-version verification

- TanStack timeline tests: **15 passed, 0 failed** in 0.24 s (`message-timeline-virtualizer`, reconnect/offset, and timeline estimation).
- Current Shiki/Pierre/data-path tests after the U6 working-tree changes: **31 passed, 0 failed** in 0.08 s (session diff, apply-patch deferral, message-file grammar metadata, markdown cache/queue/protocol/transport).
- Pierre virtualizer ownership Vitest: **1 passed, 0 failed** in 0.94 s wall time.

### Core/runtime microbenchmarks

| Scenario | Current | Candidate | Result |
|---|---:|---:|---|
| TanStack 100,000-row cold measure/range | 3.87 ms | 3.62 ms (`3.17.7`) | -6.7% |
| TanStack 1,000 end-row resizes | 41.26 ms | 27.97 ms (`3.17.7`) | -32.2%; supporting evidence for advancing patched latest |
| TanStack process RSS after scenario | 100.68 MB | 100.48 MB | effectively flat |
| Pierre parse one 500-file/40-line patch | 6.33 ms | 6.53 ms (`1.3.5`, Shiki still 4.2) | +3.2%; no win |
| Pierre parse one ~1.4 MB, 50,000-line file pair | 21.21 ms | 21.32 ms | flat |
| Pierre process RSS after parse scenario | 145.11 MB | 147.34 MB | +2.23 MB |
| Shiki 400-line TypeScript first tokenize, Oniguruma | 92.04 ms | 120.67 ms (`4.4.2`) | +31.1% slower |
| Shiki TypeScript steady tokenize | 14.65 ms | 20.16 ms | +37.7% slower |
| Shiki rare Emacs Lisp first tokenize | 331.74 ms | 404.32 ms | +21.9% slower |

The Shiki JavaScript regex engine reduced the two-grammar process RSS from 372.5 MB to 254.3 MB, but made first TypeScript tokenization **16.0×** slower, steady tokenization **8.24×** slower, and first rare-grammar tokenization **4.0×** slower. Because this worker exists only after syntax use and current U6 work releases rich state, that trade fails the interactive gate.

### Synthetic minified browser bundles

Method: Bun browser/ESM build with splitting, exact imports matching each local boundary, then gzip level 9. `entry` is first-use code; `closure` is the sum of all independently compressed emitted JS chunks, including lazy grammars. This is a comparative measurement; the implementation must regenerate the real Vite graph.

| Boundary | Current raw / gzip | Candidate raw / gzip | Delta |
|---|---:|---:|---:|
| TanStack entry, current patch vs semantically patched latest | 38,817 / 12,538 B | 38,884 / 12,539 B | +67 / **+1 B** |
| Shiki worker entry | 144,607 / 45,544 B | 142,731 / 45,237 B | -1,876 / -307 B |
| Shiki full lazy grammar closure | 9,555,236 / 1,813,577 B | 9,955,139 / 1,865,474 B | +399,903 / **+51,897 B** |
| Pierre UI entry, with Shiki fixed at 4.2 | 440,056 / 124,532 B | 493,163 / 139,484 B | +53,107 / **+14,952 B** |
| Pierre UI closure, with Shiki fixed at 4.2 | 10,060,309 / 1,921,326 B | 10,236,079 / 1,955,311 B | +175,770 / **+33,985 B** |
| Pierre worker-pool entry | 273,745 / 87,337 B | 277,383 / 88,101 B | +3,638 / +764 B |
| Pierre worker program | 622,344 / 230,474 B | identical | 0 |

An eight-language fine-grained Shiki/Oniguruma build reduced the closure to 353,789 gzip bytes and the entry to 37,275 gzip bytes, but omitted every other currently supported grammar, including the measured rare grammar. Kill it in U8; optional grammar packs belong to U10 if product policy permits them.

## Three-way option decisions

### TanStack Virtual

1. **Current patched 3.17.3 — fallback only.** Correct and fully covered by the focused tests, but misses relevant upstream chat/iOS/resize fixes.
2. **Latest 3.17.7 unpatched — killed.** API-compatible and small, but the focused regression produced only indexes `[18, 19]` instead of `[10..19]` for the oversized initial offset. Result: 1 pass, 1 fail.
3. **Latest 3.17.7 plus semantic port — selected.** Result: 2 pass, 0 fail; 32.2% faster synthetic resize loop; +1 gzip byte versus the current patched entry. This is a sufficiently narrow maintenance boundary. Keep `useAnimationFrameWithResizeObserver` off; the local code does not enable it today.

### Shiki

1. **Current 4.2.0 Oniguruma — selected.** Fastest compatible measured path; retains all grammars and current fallbacks.
2. **Latest 4.4.2 — killed for U8.** API-compatible, but common and rare token timings regress and the complete shipped closure grows.
3. **Local/fine-grained/JavaScript-engine patch — killed.** The JS engine misses latency by 4–16×. A small grammar map is fast/small only by deleting supported languages. No profiler result identifies a smaller upstream-owned patch worth carrying.

### Pierre

1. **Current 1.2.10 plus local owners — selected.** U6 already makes metadata, viewers, and workers disclosure-owned; virtualizers are shared and released; large token/word work is guarded.
2. **Latest 1.3.5 — killed for U8.** It compiles and contains desirable correctness fixes, but the measured parse paths are flat/slower, RSS rises, and the used UI entry grows 14,952 gzip bytes. Reconsider as a correctness upgrade independently of this performance program.
3. **Local fork / one pool — killed.** No measured upstream hot function justifies forking a 6.9 MB package. One pool cannot safely serve simultaneous split (`word-alt`) and unified (`none`) rendering because its render options and caches are pool-global. The current two disclosure-leased pools have zero idle workers after the last viewer closes, which addresses the memory goal without changing semantics.

## Implementation handoff and merge gates

Only the TanStack change should be made:

1. Pin `@tanstack/solid-virtual` to `3.13.36`; let its exact dependency resolve `@tanstack/virtual-core@3.17.7`.
2. Regenerate the existing patch for `3.17.7`, preserving only the effective-offset clamp and `paddingEnd` memo dependency. Remove the `3.17.3` patch entry/file rather than keeping two paths.
3. Keep the current local timeline adapters and keep ResizeObserver animation-frame deferral disabled.
4. Run the focused unit tests above, full `@claxedo/app` typecheck, and the real U8 browser cases: dynamic 40-turn append/prepend, hidden→visible reconnect, end anchoring during streaming growth, restored snapshot, and a long-history scroll gesture.
5. Regenerate the real Vite raw/gzip/module graph. Kill the upgrade if its actual TanStack-loaded chunk grows by more than 2 KiB gzip, any anchoring/reconnect test fails, or p95 frame/interaction time regresses by more than 5%.
6. Do not change Shiki or Pierre in the same lockfile diff. That keeps attribution and rollback unambiguous.

## Commands and limitations

Commands executed included:

```sh
npm view <package> version dist.unpackedSize engines peerDependencies dependencies --json
bun test --conditions=browser --preload ./happydom.ts \
  message-timeline-virtualizer.test.ts message-timeline-observe-offset.test.ts timeline-virtualization.test.ts
bun test session-diff.test.ts apply-patch-file.test.ts message-file.test.ts \
  markdown-cache-budget.test.ts markdown-worker-queue.test.ts \
  markdown-worker-protocol.test.ts markdown-worker-transport.test.ts
bunx vitest run --config vitest.config.ts pierre-virtualizer-cache.vitest.ts
bun build <synthetic-entry> --splitting --minify --target=browser --format=esm
```

Alternate-version packages were installed only in a temporary directory. Strict API smoke files were compiled with TypeScript in bundler-resolution mode. No repository install, build, formatter, source edit, or lockfile edit was performed.

Not run in this read-only spike: a fresh production Vite build, Chromium DOM/node-count comparisons on alternate packages, the complete 500-file rendered review, the 500 MB-class real-history fixture, mobile/iOS hardware, or hosted Firefox 125 qualification. Those are explicit promotion gates above, not evidence silently assumed to pass.
