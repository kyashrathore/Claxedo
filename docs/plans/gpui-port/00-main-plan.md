# Claxedo → GPUI port — main plan

Port the Claxedo app to Rust on [gpui-component](https://github.com/longbridge/gpui-component)
(the component library over Zed's GPUI), with **every feature, the same look,
running on web and cross-desktop (macOS / Windows / Linux)**.

This directory is the design: this file owns goals, architecture decisions,
phasing and gates; each sub-plan owns one domain and lists the current
implementation's canonical files so nothing is re-derived from memory.

## What we are porting (and what we are NOT)

Claxedo today is four programs:

1. **Renderer** — Solid.js app (`packages/claxedo-app`, `packages/ui`,
   `packages/session-ui`), runs in Chromium (web) and Electron (desktop).
2. **Server child** — Bun/Node bundle (`packages/claxedo-local-server` +
   `packages/claxedo-server-core`), owns sqlite, sessions, PTY, workspaces.
3. **Embedded engine** — the opencode engine artifact (10 MB ESM), imported
   in-process by the server child.
4. **Electron main** — window/menu/account/updater glue
   (`packages/claxedo-desktop`).

**The port replaces 1 and 4** (renderer + shell become one Rust/GPUI
program). **2 and 3 are NOT ported**: the server child keeps its process
boundary and HTTP/SSE contract — the GPUI app is a new client of the same
local server. This is the single most important scoping decision: the entire
session/workspace/PTY/engine domain logic stays TypeScript, already has its
own test suites, and already talks over a loopback HTTP contract that this
perf effort just measured and deduplicated (39 requests/boot, request-log
lane in `perf-harness`). Porting UI and porting domain logic at once is how
ports die.

## The web requirement — the honest problem (ADR-1, decides everything)

GPUI is a native framework (Metal/Vulkan/DirectX + platform windowing).
**There is no production web target for GPUI today.** "Every feature, same
look, on web" therefore has exactly three credible strategies, and sub-plan
`11-web-target.md` exists to pick one with a measured spike, not a hope:

- **W1 — GPUI-on-wasm/WebGPU**: compile the app to wasm, render via WebGPU.
  Upstream GPUI does not support this; a fork is a platform-engineering
  project with unbounded risk (text systems, IME, clipboard, a11y).
- **W2 — dual frontend, shared contract** (default assumption): desktop is
  GPUI; web KEEPS the existing Solid app. "Same look" is enforced by a
  shared design-token source of truth (sub-plan 02) and a screenshot-parity
  harness, not by shared pixels. Cost: two UI codebases — mitigated because
  the Solid app already exists and is now fast (this session's work).
- **W3 — remote render**: desktop GPUI app streamed to web (pixel or
  scene-graph streaming). Rejected-by-default: latency, cost, offline.

Phase 0 runs the W1 spike (time-boxed) because it is the only strategy that
satisfies the requirement literally; W2 is the fallback the rest of the plan
is compatible with either way. Every sub-plan is written so its Rust core
(layout, state, data) would survive a later W1.

## Other architecture decisions the sub-plans depend on

- **ADR-2 — one process**: GPUI app = window shell + renderer in one Rust
  process; the server child is spawned exactly as Electron main spawns it
  today (same env contract, same ready IPC — see
  `packages/claxedo-desktop/scripts/claxedo-server-startup.ts` and
  `src/shared/claxedo-server-lifecycle.ts`).
- **ADR-3 — data layer**: a Rust equivalent of the renderer's query cache
  (stale-time, dedupe, persister) is built ONCE as a crate (sub-plan 08),
  carrying over this effort's measured lessons (single-flight, staleTime
  dedupe windows, structural gating before workspace-ready).
- **ADR-4 — same look = same tokens**: the CSS token system
  (`packages/ui/src/theme/*`, `resolve.ts`, ~48.6 kB of `:root` tokens) is
  compiled to a `gpui-component` theme at build time from ONE source file.
  Look parity is gated by a screenshot-diff harness, per surface.
- **ADR-5 — text stack**: markdown via `pulldown-cmark`/comrak + tree-sitter
  highlighting (Zed's stack), NOT a shiki port. The look gate is rendered
  output parity, not tokenizer identity. Diffs likewise move to a Rust diff
  renderer (sub-plan 07) replacing @pierre/diffs.
- **ADR-6 — terminal**: `alacritty_terminal` (as Zed does) in-process,
  speaking to the SAME server-side PTY endpoints (the PTY stays owned by the
  server child so web and desktop share it).

## Sub-plans

| # | file | owns |
|---|---|---|
| 01 | 01-runtime-architecture.md | process model, server-child spawn, IPC, packaging, updater |
| 02 | 02-design-system-theming.md | tokens→GPUI theme, fonts, icons, dark/light, "same look" gates |
| 03 | 03-session-timeline-streaming.md | timeline virtualization, markdown, highlighting, streaming 60Hz |
| 04 | 04-composer-input.md | prompt editor, attachments, slash/mode commands, IME, keybindings |
| 05 | 05-terminal.md | terminal surface, PTY transport, scrollback, reflow |
| 06 | 06-workbench-shell.md | rail, panes/splits/tabs (gpui-component Dock), navigation, persistence |
| 07 | 07-review-diffs.md | diff/review workspace, file tree, comments |
| 08 | 08-data-layer-transport.md | query cache crate, SSE/event stream, offline, request discipline |
| 09 | 09-auth-account-remote.md | Clerk auth (webview flow), hosted workspaces, relay |
| 10 | 10-feature-parity-matrix.md | exhaustive feature inventory → sub-plan ownership, gaps |
| 11 | 11-web-target.md | ADR-1 spike design and decision record |
| 12 | 12-migration-testing-perf.md | strangler order, parity harness, perf gates carried over |
| 13 | 13-harness-roster.md | multi-harness parity; DeepSeek Harness (dsh) evaluation |

## Phasing

- **Phase 0 — spikes (time-boxed)**: W1 wasm spike (11); tokens→GPUI theme
  compiler + one pixel-parity screen (02); server-child spawn + /provider
  round trip from Rust (01); markdown+highlight of the corpus transcript at
  60Hz (03). Each spike has a kill criterion written in its sub-plan.
- **Phase 1 — walking skeleton**: one window, rail + one session timeline
  reading REAL server data, theme applied, packaged on all three desktops.
- **Phase 2 — session core**: composer, streaming, terminal, session switch
  at the perf gates (12).
- **Phase 3 — workbench**: splits/tabs/review/workgraph/documents/settings.
- **Phase 4 — accounts/remote/updater; ship-parallel** (strangler: GPUI app
  is opt-in beta while Electron remains default until parity matrix is green).

## Gates (carried over from this perf effort)

The port must not regress what was just won. Every phase gate reuses the
existing instruments: the browser lane's scenario shapes re-implemented for
the GPUI app (session-switch completion ≤ 500 ms, zero >16.7 ms tasks on
switch steady-state), boot request count ≤ 39, cold start ≤ the Electron
app's measured shell readyMs on the same host, RSS budget from HANDOFF §1.1
(~950 MiB family → the GPUI target must beat it substantially; a single
native process should land under 400 MiB on the same corpus).

## Top risks, ranked

1. **Web target (ADR-1)** — if W1 fails and W2 is unacceptable to the
   requirement's author, the port premise changes; surface this at the end
   of Phase 0, not later.
2. **Text fidelity** ("same look" for markdown/code/diff rendering) — Rust
   stack renders differently than Chromium; the parity harness must define
   acceptable deltas per surface early (02/03/07).
3. **A11y + IME** — GPUI's screen-reader and IME support lag Chromium's;
   inventory in 04/10 what the product actually relies on.
4. **Auth without Chromium** (09) — Clerk flows assume a browser; desktop
   uses a system-browser + loopback callback or wry WebView.
5. **Two-frontend drift under W2** — mitigated by the shared token source,
   shared contract tests against the server child, and the parity matrix.
