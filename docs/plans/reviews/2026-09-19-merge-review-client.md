# Merge review (client half) of `d94e4250d9..518a6b9e98` — verdict: GO WITH FIXES

1. MAJOR (product, documented) — a local workspace not routed on the desktop loses live agent/pty frames: no completion or permission sound, no rail "done" dot, no sandbox auto-tab until the next switch heals indicators from the runtime's record. Dev's central stream carried these for every local workspace. Accepted in rounds 5/8 — to be accepted explicitly, not by default.
2. MINOR (cost) — `reconcileAgentStatuses` does resolve + pty list + one `terminal-session` read per owned terminal, sequentially, on every workspace stream-up, with no quiet gating.
3. MINOR — `ready()` waits for nothing when no workspace lane is registered yet; a first prompt sent before the catalog resolves streams nothing and arrives as a burst via the stream-open resync.
4. NIT — `session-history-resync.ts` keeps a `sessionID` request arm no producer sets.
5. NIT — `controlPlaneReconnects` counts a return the level already showed when both planes dropped and the other came back first.
6. NIT (low confidence) — the local "Reconnecting…" line pairs `wr:${workspaceId ?? id ?? key}` with `replayWorkspaceId`; a catalog entry with neither id never shows it. Untested.
7. NIT — the plan ended "Round 11: see below" with nothing below.

Verified clean: exactly two streams opened with one reader; the full consumer map has no duplicate or wrong-stream reader; every deleted module's responsibility landed or has zero consumers; retired names gone from app, e2e and desktop source; pre-existing architecture reds at dev's levels.
