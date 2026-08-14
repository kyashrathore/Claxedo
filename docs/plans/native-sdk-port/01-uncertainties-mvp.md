# 01 — Uncertainties and the de-risking MVP

The MVP is a walking skeleton of the risks, not a small app. Certain
things are excluded on purpose: layout containers, dialogs, tabs, token
plumbing, packaging — the SDK's docs and seven examples (including a
chatbot) demonstrate them. Build only what is listed here; each slice has
a pass/kill criterion filled in as a verdict when it runs.

## The uncertainties, ranked

**U1 — Transcript fidelity + text selection (the pivot's own premise).**
The SDK's `<markdown>`/`<code>` widgets must render OUR corpus — code
blocks, pipe tables, task lists, `<details>`, long paragraphs, inline
code — at acceptable parity with the web app, with drag-selection working
across all of it (docs claim static text selects; verify it spans widget
boundaries, e.g. selecting across a paragraph + code block).
KaTeX/Mermaid have no built-in path — spike the server-child MathJax-SVG
route and the WebView-island route (SDK ships a WebView-composition
example); mermaid may ship as fallback-to-code-block via the existing
`mermaid-backend` seam.
*Slice S1*: render the perf-corpus transcript in a `<markdown>`-based
timeline; screenshot-diff vs the web app; a written selection checklist.
*Kill*: if GFM coverage or selection is materially short and the gap needs
forking the SDK's text pipeline, the pivot premise fails — record and
re-evaluate (the GPUI plan is recoverable from git history).

**U2 — Streaming re-render at 60Hz, especially on Linux.** Our hardest
measured path (session-switch 2,559→503 ms this effort). The SDK re-renders
from state via its update/view model; unknown: incremental markdown
re-parse + re-layout cost inside a `virtualized` list while a message
streams. Linux is a DETERMINISTIC SOFTWARE RENDERER — the 60Hz gate must
be proven there, not on Metal.
*Slice S2*: synthetic 200 tok/s stream into the S1 timeline on macOS AND
Linux; frame instrumentation. *Gate*: zero >16.7 ms frames at steady
state. *Kill*: if Linux software rendering cannot hold the gate on the
corpus, Linux ships degraded or the pivot is re-evaluated — measured,
either way.

**U3 — TS-cores expressiveness for our state layer.** Cores are a closed
runtime: AOT-compiled TS subset, no npm ecosystem, no DOM, markup
expressions bounded (256 bytes/64 terms/16 nesting). Our renderer's query
cache (stale-time, single-flight, persister), SSE consumption, and
timeline row derivation must be REWRITTEN inside this model — the
question is whether the model can express them at all, cleanly.
*Slice S3a*: port the query-cache core (staleTime dedupe + single-flight +
structural gating) as a TS core with unit tests. *Kill*: if cores lack
what this needs (timers, async HTTP, streaming reads — verify each
against the actual core API), the port needs its logic in Zig instead —
a different (costlier) project; price it before proceeding.

**U4 — Server-child spawn + ready handshake + HTTP/SSE from the native
app.** The child reports readiness via Node IPC (`process.send`,
`NODE_CHANNEL_FD`) — a Native SDK parent will not speak that. Add a
parallel ready path (stdout line or poll `/api/claxedo/health`) to
`claxedo-server-lifecycle.ts` — cheap, but also verify the app side: can
a core (or the Zig shell) spawn a process with our env contract, then
consume HTTP + SSE?
*Slice S3b* (same skeleton as S3a): spawn the REAL server bundle, receive
ready, fetch the real session list, subscribe to the real event stream.
*Pass*: live data rendered in a list.

**U5 — Terminal surface.** No terminal widget exists in the SDK. PTY and
process ownership stay in the server child (unchanged contract); the
emulator + renderer is ours: a Zig `canvas.Ui` surface. Candidate:
libghostty (Zig terminal emulation) if embeddable; else a scoped vt
subset. This was free under GPUI (`alacritty_terminal`) — it is the
single biggest NEW cost of the pivot; say so plainly.
*Slice S4*: echo + vim + scrollback over the real PTY websocket in a Zig
canvas. *Kill criterion is a budget*: if the spike shows emulator work is
months, Phase 2 re-plans around an interim degraded terminal (or embeds
the web terminal in a WebView island) with the cost written down.

**U6 — "Same look" through a closed token vocabulary.** Our ~48.6 kB
token system maps onto the SDK's fixed token list (background/surface/
text/accent/…, `syntax_*`, radius sm–xl, typography rungs) — lossy by
construction, and per-element styling escapes exist only in Zig.
*Slice S5*: token compiler (one source → CSS + SDK tokens) + one
pixel-parity screen (session timeline) diffed against the web app in
light + dark. *Gate*: agreed per-surface delta, written BEFORE looking.

**U7 — IME + a11y, verified not assumed.** The SDK's posture is notably
strong on paper (structured IME events incl. composition on Linux/
Windows; compile-time accessible-name validation; a11y audit sweeps in
tests; automation snapshots carry semantics). Verify against the product
checklist (CJK composition in the composer, screen reader on the
timeline).
*Slice S6*: the S1 skeleton + a `textarea` composer run through the
checklist on macOS + Windows. *Pass*: no product-breaking gaps; residual
gaps are upstream issues to file, listed with links.

**U11 — Solid 2.0 as the web renderer (owner's decision, sub-plan 03).**
Two parts. (a) The existing web app's Solid 1 → 2 migration: staged
microtask writes, compute/apply effects, store drafts, removed
`batch`/`onMount`/`createResource`/`produce`, `@solidjs/web` — touches
most of `claxedo-app`; the e2e suite and perf gates are the acceptance
harness, and the effort must be priced by migrating ONE heavy feature
(the session timeline) first. (b) The Elm bridge on Solid 2 semantics:
confirm a `reconcile` equivalent exists for draft-setter stores, else
write the keyed structural diff; prove streaming still repaints at
binding granularity under microtask-committed writes (the 60Hz gate on
the corpus, re-run under Solid 2).
*Kill/deferral criterion*: if the RC churns breaking between pinned
upgrades twice in Phase 0–1, freeze on the last good pin and re-evaluate
at Solid 2 stable rather than chasing it.

**U8 — Pre-1.0 platform risk.** "APIs still move, and the toolkit is
evolving quickly" (their words). Not spikeable — managed: pin exact SDK
versions (their compiler ships exact-pinned already), vendor the token
compiler on our side of the boundary, keep every spike on one pinned
version, and record upstream issues filed. Re-check churn at each phase
gate; Apache-2.0 keeps a fork as last resort.

## What the MVP is, concretely

- **The skeleton binary** (S1 + S2 + S3a/b + S6): spawns the real server
  child, renders one real transcript with selection, streams at 60Hz with
  instrumentation, minimal composer for IME. No docks, no settings, no
  second window.
- **The terminal spike** (S4): separate Zig canvas program against the
  real PTY endpoint.
- **The token compiler + parity screen** (S5): build-time tool + one
  diffed screen.
- **Math/mermaid spike** (inside S1): MathJax-SVG via the server child
  rendered as an image in the timeline; WebView-island variant if that
  fails the look gate. Mermaid frequency measured from real session data
  before any emulator-shim work is priced.

Phase 0 exits when every U1–U8 verdict is written here. The web story
needs no spike: it is the existing Solid app by decision (ADR-1).
