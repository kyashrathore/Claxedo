# 03 — Session timeline, markdown, streaming (60Hz core)

## Scope
The message timeline: virtualization, markdown/code rendering, streaming
updates, code-block highlight cache, scroll anchoring. This is the surface
all this session's reactivity fixes live in — port the LESSONS, not the bugs.

## Current implementation
- Timeline: `packages/claxedo-app/src/features/session/ui/message-timeline*`
  (row model in `timeline-row-model.ts`, per-message equality gating landed
  in 6d9b5bb — one part delta must NOT rebuild all turns), virtualizer via
  patched `@tanstack/virtual-core` (`patches/@tanstack%2Fvirtual-core...`),
  restore-first offset reconnect (`message-timeline-observe-offset.ts`,
  a0b91a5), bottom-anchor rules (`timeline-virtualization.ts`).
- Markdown: `packages/session-ui/src/components/markdown.tsx` + worker
  (`markdown-shiki.worker.ts`), module-LRU completed-code cache
  (`markdown-code-cache.ts`, this session), lazy math (`marked-math.ts`).
- Projection identity contract: `conversation-registry.reactivity.test.ts`
  (WeakMap identity stability — the tripwire the row gating depends on).

## Target design
- GPUI `uniform_list`/custom variable-height list (gpui-component List) with
  the row-model logic ported as a plain Rust module + unit tests (the tagged
  TimelineRow union ports cleanly to an enum).
- Markdown: comrak/pulldown-cmark AST → GPUI elements; highlighting via
  tree-sitter grammars (Zed's), on a worker thread, with the SAME cache
  policy (bounded LRU keyed content-hash+lang+theme; never cache mid-stream).
- Streaming: server SSE → a per-session channel; apply deltas with
  per-message invalidation granularity BY CONSTRUCTION (Rust makes the
  equality gates explicit instead of retrofitted).
- Scroll: port the restore-first reconnect + bottom-anchor semantics as a
  spec'd state machine with the existing test cases translated.

## Spike + kill criterion
Render the 217-row corpus transcript (HANDOFF's corpus), stream a synthetic
80-message session at real cadence; frame budget: zero >16.7 ms UI-thread
tasks during steady-state streaming on the reference machine. KILL the
tree-sitter choice (fall back to syntect) if grammar coverage misses
languages the corpus uses.

## Acceptance
Session-switch scenario (12) ≤ 500 ms completion; look parity per 02 bands;
math/mermaid: mermaid via embedded webview or server-side render — decide in
Phase 2 (record as open question, mermaid is the one true HTML dependency).
