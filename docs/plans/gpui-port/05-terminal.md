# 05 — Terminal

## Scope
Terminal surfaces in panes, scrollback, resize/reflow, links, selection.

## Current implementation
- UI: `packages/claxedo-app/src/features/terminal/**` (xterm.js behind the
  #terminal-backend alias, WebGL addon, serialize addon for restore; tuning
  constants `terminal-limits.ts` — HANDOFF §11.3 notes they were never
  varied experimentally).
- Server: PTY owned by workspace-runtime (`@lydell/node-pty` after this
  session's consolidation), disk-history compaction (`pty/history-disk.ts`),
  echo/batching semantics documented in HANDOFF (64 KiB observer window).
- Transport: server routes; reconnect-repair presentation gate (retained,
  HANDOFF §4).

## Target design
- `alacritty_terminal` crate for the grid/parser (Zed-proven), GPUI renders
  the grid; keep the PTY server-side over the SAME endpoints so web (W2) and
  desktop share behavior — the GPUI app is just another attach.
- Port the reconnect offset-repair semantics (they were measured to fix warm
  p95 188→139 ms and never regress) as a transport-layer state machine.
- Scrollback restore from the server's serialized history, not client state.

## Acceptance
`terminal.output_mib_s` ≥ 20 (HANDOFF M8 workload replayed against the GPUI
grid); input→paint p95 ≤ 100 ms (M7 shape); reflow correctness vs xterm on a
recorded corpus (byte-identical grid states on a golden set).
