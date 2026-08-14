# 07 — Review & diffs

## Scope
Review workspace (500-file progressive review), diff rendering
(split/unified), file tree, line comments, sticky headers.

## Current implementation
- `packages/claxedo-app/src/features/review/ui/review-session.tsx` —
  idle-admission of heavy sticky accordion headers (17–54 ms/tick measured;
  the windowed-header experiment and its honest null are in the session doc
  Addendum 3 — those MECHANISMS are this port's checklist).
- Diff engine: `@pierre/diffs` (FileRenderer/DiffHunksRenderer + shiki
  stream) behind `packages/session-ui/src/components/file.tsx` — note the
  two-worker-pool split/unified design that tears down and rebuilds the
  FileDiff on every toggle (file.tsx:1086; measured 20–44 ms click tasks).
- Line comments: `packages/session-ui/src/components/line-comment*`.

## Target design
- Rust diff: `similar` or `imara-diff` for hunk computation + tree-sitter
  highlighting, rendered as GPUI list rows; split/unified becomes a LAYOUT
  mode over ONE model — explicitly not two engines, which kills the
  toggle-rebuild defect class at the design level.
- Sticky headers native to the list implementation, cost independent of
  admitted-header count (the style-recalc-growth mechanism measured here).
- Comments anchor to the hunk model, not rendered nodes.

## Spike + kill criterion
500-file corpus review: initial admission progressive, split/unified toggle
re-lays out visible rows within one frame budget and fully settles ≤ 100 ms.
KILL the diff-crate choice if hunk output diverges from git's own on the
golden corpus (byte-compare against `git diff` output).
