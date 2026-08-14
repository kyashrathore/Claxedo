# Claxedo → Native SDK port — main plan

Port the Claxedo desktop app to [Native SDK](https://native-sdk.dev/)
(Vercel Labs, `vercel-labs/native`, Apache-2.0, ~7.4k stars, pre-1.0):
declarative native markup + TypeScript cores AOT-compiled to native code
(Zig first-class), rendered by the SDK's own engine into real OS windows —
no browser, no WebView, no JS runtime in the binary.

## Decision record — why this replaces the GPUI plan (2026-08-14)

The GPUI port plan (13 sub-plans) was deleted at the owner's direction;
it remains recoverable at git commits `3ea95f7`/`073e9a0`. The triggering
concern was transcript text selection. For the record: GPUI the framework
CAN select text (Zed's editor surfaces), but arbitrary UI text is not
selectable for free — every surface must implement it. Native SDK ships
drag-selection on static text as a built-in ("dragging still selects
text"), plus first-class `<markdown>` and `<code>` widgets, virtualized
lists, split panes, an explicit IME event model, and compile-time a11y
validation. Selectable transcript text is a NAMED GATE in this plan
(sub-plan 01, S1) so the deciding concern is verified, not assumed.

Secondary factors in the pivot: logic stays TypeScript (team skill
retention), Apache-2.0 (vs tracking/forking Zed's repo — the shipped GPUI
agent app waku runs on a gpui fork), and a built-in automation API
(snapshots/assertions/screenshots) that matches our parity-harness needs.
Honest costs accepted: pre-1.0 API churn, a closed widget grammar and
closed token vocabulary (less pixel-level control than GPUI), Linux is a
software renderer (60Hz gate must be proven there), and there is no
built-in terminal widget.

## What we are porting (and what we are NOT) — unchanged from before

Claxedo today is four programs: (1) Solid.js renderer, (2) Bun/Node server
child (`claxedo-local-server` + `claxedo-server-core`: sqlite, sessions,
PTY, workspaces), (3) embedded opencode engine (in-process in 2),
(4) Electron main.

**The port replaces 1 and 4** (renderer + shell become one Native SDK
program). **2 and 3 are NOT ported**: the server child keeps its process
boundary and HTTP/SSE contract; the native app is a new client of the same
local server. All domain logic stays TypeScript with its existing tests.
Porting UI and domain logic at once is how ports die.

## Architecture decisions

- **ADR-1 — web target**: Native SDK has NO browser target (WebViews exist
  for embedding web content in the desktop app, not for running the app on
  the web). Therefore the web strategy is decided, not spiked: **dual
  frontend** — web KEEPS the existing (now fast: 292 kB gzip eager, boot
  waterfall killed) Solid app. "Same look" is enforced by a shared design-
  token source compiled to both CSS and Native SDK tokens, plus a
  screenshot-parity harness. This is simpler than the GPUI plan's W1/W2
  fork: there is no wasm option to spike.
- **ADR-2 — one process + server child**: the native app spawns the server
  child exactly as Electron main does (same env contract; the ready
  handshake currently uses Node IPC `process.send` — see uncertainty U4 in
  sub-plan 01; a stdout/HTTP-poll ready path may be added to
  `claxedo-server-lifecycle.ts`).
- **ADR-3 — logic in TypeScript cores, surfaces in Zig where needed**:
  business/UI state follows the SDK's message/update model in TS cores.
  Custom surfaces the closed grammar cannot express (terminal, any
  perf-critical timeline pieces) use Zig `canvas.Ui` view functions —
  the SDK's own escape hatch, "produces exactly the same trees the markup
  compiles to."
- **ADR-4 — same look = token compilation**: our CSS token system
  (`packages/ui/src/theme/*`, ~48.6 kB of `:root` tokens) compiles to the
  SDK's CLOSED token vocabulary (background/surface/text/accent/…,
  `syntax_*` roles, radius steps, typography rungs). The mapping is lossy
  by construction — look-parity gates decide whether lossy is acceptable
  (sub-plan 01, S5).
- **ADR-5 — markdown/code via built-in widgets**: `<markdown>` (GFM incl.
  tables, task lists, `<details>`) and `<code>` (built-in highlighting,
  wrapping, line numbers) replace marked+shiki. Gate is rendered-output
  parity on the real corpus, not tokenizer identity. KaTeX/Mermaid have no
  built-in path — options unchanged from the prior analysis (server-child
  MathJax-SVG; WebView island — the SDK ships a WebView-composition
  example; fallback-to-code-block for mermaid via the existing tested
  `mermaid-backend` seam).
- **ADR-6 — terminal is OUR problem here**: no terminal widget exists.
  The PTY stays server-side (unchanged); the emulator/render surface is a
  Zig canvas spike — candidate: libghostty (Zig-native terminal emulation
  library) — see uncertainty U5.

## Phasing — MVP built ONLY around the uncertainties

Per the owner's directive, there is no "small version of the app" phase.
Phase 0 is the de-risking MVP defined in `01-uncertainties-mvp.md`: one
skeleton binary + side spikes, each with a pass/kill criterion, touching
ONLY the things that could kill or reshape the port. Everything the SDK
demonstrably does (layout, lists, dialogs, theming plumbing, packaging)
is deliberately absent from Phase 0.

- **Phase 0 — the uncertainty MVP** (sub-plan 01). Exit: every U1–U8 has a
  written verdict.
- **Phase 1 — walking skeleton**: one window, rail + one session timeline
  on REAL server data, tokens applied, packaged on all three desktops.
- **Phase 2 — session core**: composer, streaming, terminal, session
  switch at the perf gates.
- **Phase 3 — workbench**: splits/tabs/review/settings; parity matrix.
- **Phase 4 — accounts/remote/updater; ship-parallel** (native app opt-in
  beta while Electron remains default until the parity matrix is green).

## Gates (carried over from the perf effort, unchanged)

Session-switch completion ≤ 500 ms with zero >16.7 ms tasks at steady
state; boot request count ≤ 39; cold start ≤ the Electron app's measured
shell readyMs on the same host; RSS: the ~950 MiB Electron family number
must fall to <400 MiB (SDK claims 3–6 MB binaries with no runtime — memory
is the metric to verify, on Linux's software renderer especially).
Plus the new named gate: transcript text is selectable everywhere.

## Sub-plans

| # | file | owns |
|---|---|---|
| 01 | 01-uncertainties-mvp.md | the eight uncertainties, MVP slices, kill criteria |
| 02 | 02-harness-roster.md | multi-harness parity; DeepSeek Harness evaluation (carried over) |

Further sub-plans (tokens compiler, data layer, workbench mapping) are
written AFTER Phase 0 verdicts, so they are grounded in what the spikes
proved rather than in docs-reading.
