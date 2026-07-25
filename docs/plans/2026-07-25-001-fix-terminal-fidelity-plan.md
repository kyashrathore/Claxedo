---
title: "fix: Terminal fidelity — data path, rendering, modes, and restore honesty"
date: 2026-07-25
type: fix
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
reference: ~/test/superset-terminal-ref (Superset, @ 98cea86b0, 2026-07-24)
revision: 2 — rewritten after a full read of both terminal codebases
---

# fix: Terminal fidelity — data path, rendering, modes, and restore honesty

## Goal Capsule

- **Objective:** A **very reliable** terminal. Concretely: (a) deliver PTY bytes
  without corrupting them, (b) render correctly, (c) never spray escape junk into
  a shell, and (d) never show restored scrollback it is about to destroy.
- **Method:** Conform to the reference's *tests*, not its code. See "How to use
  the reference" below — porting implementation is a means, and in several areas
  it would be a regression.
- **Authority:** `packages/claxedo-app/src/features/terminal/**`,
  `packages/workspace-runtime/src/pty/**`, and the `@xterm/*` pins.
- **Stop conditions:** Stop W1 if the `@xterm/*` bump regresses the ligatures
  build. Stop W7 if the wheel handler ships without its matching `TERM_PROGRAM`
  identity — the two are a coupled pair (see below).

**Correction to the first revision of this plan.** It listed "identify as
`TERM_PROGRAM=vscode`" (their `#5563`, 2026-07-09) as a gap. That commit was
**superseded three days later** by `#5642` (2026-07-12), which reverted the
identity to `kitty` and shipped it together with a full-fidelity wheel handler.
Their current constant is `TERMINAL_TERM_PROGRAM = "kitty"` with a CI test
enforcing the coupling, because under a `vscode` identity Claude Code amplifies
each wheel report to compensate for xterm's damped stock stream and over-scrolls
~3x. Taking the earlier commit alone would have been actively wrong. See W7.

---

## Shape of the two codebases

Line count is **not** the interesting axis and should not be read as a capability
gap. Their `*terminal*` tree is 33,887 non-test lines, but ~11.2k of that is
carrying v1 and v2 implementations simultaneously mid-migration (`#5818`), ~3.8k
is settings/presets UI, and ~1.4k is a CLI/MCP/SDK `terminals` command surface.
The genuinely comparable core — renderer terminal lib + pane UI + host session
management — is ~11.7k against our ~9.4k. Our test volume is *heavier* than
theirs in absolute terms (14.3k vs 15.9k lines, on a third of the source).

The gap that matters is architectural, and it does not correlate with size:

| | Ours | Theirs |
|---|---|---|
| xterm lifetime | bound to the Solid component | long-lived "runtime", parked in a hidden DOM node |
| Mode restoration | client-side regex scan → localStorage snapshot | server-side headless xterm mirroring live PTY output |
| PTY ownership | in-process in the sidecar, dies with the app | standalone `pty-daemon` over AF_UNIX, survives host restarts + binary upgrades |
| PTY wire format | UTF-16 JS strings | `Uint8Array` end to end |

---

## How to use the reference: conform to their tests, don't copy their code

**The objective is a terminal that is very reliable — not a terminal that
resembles Superset's.** Their implementation is one answer shaped by their
process topology (host-service + pty-daemon + relay); ours is different and in
places already better. What transfers cleanly is their **test suite**: 904 cases
across 63 files, each one a failure someone actually hit. That is a behavioural
spec, and it is valid against our implementation regardless of how we build it.

So for every work package below: read the relevant test titles, decide whether
the case can occur in *our* design, and if it can, cover it *our* way. Porting
code is a means, never the goal — and in the areas where we already win
(below), porting would be a regression.

### Conformance checklist

Case counts are comparable: **ours 828, theirs 904.** The distribution is what
differs.

**Where we already conform, or beat them** — do not "port" these:

| Case class | Our coverage |
|---|---|
| DECSET/DECRST modes split across chunks | `mode-scan.test.ts` — mouse SGR, app cursor keys, multi-mode sequence, bracketed paste, all split-chunk |
| OSC-7 CWD split across chunks | covered; also multiple-CWD-per-chunk and empty-chunk |
| Terminal query/reply suppression across chunks | `query-suppression.test.ts` — CPR, DCS, `CSI $ y`, OSC-before-BEL, OSC-inside-ST, long replies past the tail limit. They have no equivalent file; their nearest is one "drops DA during pending state" case |
| Incomplete escape fragments not eaten | `keeps incomplete escape fragments to avoid eating user ESC` |
| UTF-8 byte vs UTF-16 code-unit accounting | `terminal-stream.ts` counts UTF-8 bytes, with `pushStream counts utf8 bytes rather than utf16 code units` pinning it |
| Unicode-safe chunk capping | `capChunk does not split a unicode code point` |
| Recovery / lifecycle | `clone-recovery`, `relay-lifecycle`, `zombie`, `pane-terminal-recovery`, `websocket-backpressure`, `terminal-paste-duplication`, `terminal-role-gate` — no counterparts on their side |

The UTF-8/UTF-16 row is the important one: **we already knew about that
distinction and fixed it in the client queue.** F1/F2 are the same bug class
surviving in two layers the fix never reached — the decode hop and the
server-side cursor. That is a gap in *propagation*, not in understanding, which
makes it cheap to close.

**Where a case they cover can occur in our design and we do not cover it:**

| Their case | Our state |
|---|---|
| `detects marker split across two PTY data frames` (shell-ready) | **Real gap.** [pty/index.ts:564](packages/workspace-runtime/src/pty/index.ts:564) is `data.includes("claxedo-shell-ready")` — single-frame, no carry buffer. A marker straddling a chunk boundary is missed and the initial command falls back to the 1200ms timer. We solved exactly this for OSC-7 and modes; the marker check never got the same treatment |
| `keeps queued byte accounting exact when chunking across a surrogate pair boundary` | not covered |
| `escape sequences split across feeds are still parsed` (mode tracker) | covered for our scanner, but F7 replaces that layer — re-assert on the new one |
| `parser-idle-gate` (8 cases) | no equivalent — W4 |
| `font-settle` (5 cases, incl. the open-before-load race) | no equivalent — W3 |
| `terminalInputModeReclaimer` (9 cases) | no equivalent — W5 |
| `terminal-wheel-handler` + `terminal-identity-coupling` | no equivalent — W7 |
| `terminal-title-scanner` (20+ cases: fragmented OSC introducers/ST, C1 forms, ConEmu, code-point-safe truncation, Braille spinner stripping, replacement-char stripping) | **we have no OSC 0/2 title scanner at all** — terminal tabs never self-title from the running program. Feature gap, not a defect |
| `terminal-runtime-registry` / eviction (9 cases) | N/A unless W9 lands |

**Where their test encodes a trap we avoid by construction:** their
`terminal-escape-filter` asserts RIS (`ESC c`) must *not* be treated as a
scrollback clear, because TUIs emit it for repaints. Our
[escape-filter.ts](packages/workspace-runtime/src/pty/escape-filter.ts) only
matches ED3, so we never had the bug — but note ours is also a single-frame
`includes()`, so a `ESC [ 3` / `J` split across chunks is missed. Neither suite
covers that; our byte path makes it likelier.

## Explicitly out of scope

Their terminal tree carries product surfaces we are deliberately **not** taking.
Recorded here so a later reader doesn't mistake them for gaps:

- **Warp-style rich input overlay** (`#5453`, `#5522`) — a Tiptap composer opened
  over a terminal pane with ⌘I that submits a multi-line prompt into the running
  agent's PTY via bracketed paste + CR. Owner decision: not wanted. Cleanly
  separable — ~300 lines confined to `TerminalPane/components/TerminalRichInput/`
  + `richInputOpenStore.ts`, and the dependency is one-way (the overlay consumes
  the runtime registry, never the reverse). Zero `richInput` references exist in
  `renderer/lib/terminal`, `packages/shared`, `packages/host-service`, or
  `packages/pty-daemon` — none of the code W2–W9 ports from.
- **Terminal settings / presets UI** (~3.8k lines) — preset editors, session
  dropdowns, appearance controls.
- **`terminals` CLI / MCP / SDK command surface** (`#5256`, ~1.4k lines) —
  create/send/read/close/list against running terminal agents. Not ruled out by
  the owner as of this revision, but not planned here.

## Findings

Grouped by severity. Everything below is read out of the two trees, not inferred.

### Tier 1 — Data-path corruption (new; these are the "rendering" bugs)

These three are the most likely cause of visible garbage, and none of them were
in revision 1 of this plan.

#### F1. UTF-8 is decoded per-frame with no streaming — **LATENT, not live** (corrected 2026-07-25)

**Correction after implementation-time verification.** This was originally filed
as the primary cause of visible garbage. It is not. Our server sends PTY output
as WebSocket **text** frames (`safeBroadcast`/`safeReplay` pass JS strings to
`ws.send`), so the browser delivers them as `string` and the decode branch is
never reached. The relay preserves the distinction — `encodedFrame` tags
`binary: false` for strings and `decodedFrame` returns `body.toString("utf8")` —
so a relayed workspace behaves the same. Only the 0x00-prefixed meta frame is
binary.

The defect below is therefore a **latent hazard**, not a live corruption: the
branch is wrong, and it is a trap for anyone migrating the path to bytes (W9 or
a future relay change). Keep the fix; drop the severity.

Original analysis retained:
[terminal.tsx:844](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:844)
creates `new TextDecoder()` and
[terminal.tsx:1012](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:1012)
calls `decoder.decode(bytes)` — **without `{ stream: true }`**. Each WebSocket
frame is therefore decoded as a *complete* input. A multi-byte UTF-8 sequence
split across two frames becomes `U+FFFD` on both sides.

PTY reads are chunked at kernel buffer boundaries with no regard for codepoint
alignment, and agent TUIs emit box-drawing, powerline glyphs and emoji
continuously — so this fires in normal use, not just at the margins.

Superset's transport carries this comment verbatim:

> PTY output bytes arrive as binary WebSocket frames and are fed straight into
> `xterm.write(Uint8Array)` — no UTF-8 decoding hop, so multi-byte codepoints
> that straddle a frame boundary stay intact (xterm.js buffers partial sequences
> internally). Control messages (title/error/exit) stay JSON.

**Fix:** feed bytes into xterm directly. Failing that, `{ stream: true }`. The
byte path is strictly better and removes F2's re-encode entirely.

#### F2. Replay cursor is counted in two different units — **CONFIRMED LIVE**

Verified end to end at implementation time. The failure is silent output loss on
every reconnect after any non-ASCII output:

1. On attach the server sends a meta frame carrying its own cursor; the client
   adopts it ([terminal.tsx:1004](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:1004)),
   so both sides start correct.
2. The client then advances that cursor by **UTF-8 byte length** per chunk while
   the server advances by **UTF-16 code units**. UTF-8 bytes ≥ UTF-16 units for
   all non-ASCII, so the client's cursor drifts strictly *ahead*.
3. On reconnect the client sends its live cursor
   ([terminal.tsx:866](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:866)),
   the server evaluates `from >= end` → **`return ""`** — the output produced
   while disconnected is dropped, with no error.
4. The drifted cursor is also persisted into the snapshot
   ([terminal.tsx:301](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:301)),
   so it feeds `cursorPlan` on the next mount and can start a replay at a wrong
   offset — which is how F2 feeds F3.

**Fix shape (chosen).** The cursor is an *index into the server's UTF-16 string
buffer* — that is the only coherent reading, since `connect()` uses it as a
`String.slice` offset. So the client must count the same way: `data.length`, not
`encoder.encode(data).byteLength`. One-line client change, no protocol or
buffer-format change, exact agreement because the client receives the identical
string the server sent.

Original analysis:
- **Server** ([pty/index.ts:569](packages/workspace-runtime/src/pty/index.ts:569)):
  `session.cursor += data.length` where `data` is a **JS string** from
  `node-pty.onData` → UTF-16 code units.
- **Client** ([terminal.tsx:1023](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:1023)):
  `cursor += encoder.encode(data).byteLength` → **UTF-8 bytes**.

The client sends that number back as `?cursor=N`, and
[pty/index.ts:710-718](packages/workspace-runtime/src/pty/index.ts:710) uses it
as a **code-unit offset** into `session.buffer`.

For pure ASCII the two agree. For anything else the client's cursor runs ahead,
so on reconnect either `from >= end` (replay silently returns `""` — output
lost) or the slice starts at the wrong offset (replay begins mid-sequence).
Every TUI produces non-ASCII, so every TUI reconnect is at risk.

Worse, F1 feeds F2: if decoding produced `U+FFFD`, re-encoding it yields 3 bytes
where the original may have been 2 or 4, so the cursor drifts even for content
that was never split.

#### F3. Buffers and history are sliced at arbitrary string offsets
Three places cut a JS string mid-content to enforce a size cap:
- [pty/index.ts:598](packages/workspace-runtime/src/pty/index.ts:598) — `session.buffer.slice(excess)`
- [history.ts:22](packages/workspace-runtime/src/pty/history.ts:22) — `head.slice(excess)`
- [history.ts:42](packages/workspace-runtime/src/pty/history.ts:42) — `joined.slice(-cap)`

An arbitrary offset can land **inside a surrogate pair** (lone surrogate →
replacement char) and, more damagingly, **inside an ANSI escape sequence** — the
restored buffer then begins mid-escape and xterm renders the tail as literal
text. That is a direct candidate for the junk seen at the top of a restored
terminal.

Superset's FIFO holds whole `Uint8Array` chunks and evicts **whole chunks only**
(`while (bufferBytes > MAX && buffer.length > 1) buffer.shift()`) — it never
slices within a chunk. That discipline is the fix.

### Tier 2 — Rendering

#### F4. WebGL shared-atlas garble (upstream, fixed in a version we don't have)
`@xterm/addon-webgl@0.20.0-beta.219`, `@xterm/xterm@6.1.0-beta.220`. Terminals
sharing a texture atlas (same font/theme/DPR — all of ours) render garbled
multicolour glyph fragments after another terminal triggers an atlas page merge:
the consume-once invalidation flag is eaten by the first renderer to draw,
leaving siblings with stale glyph→texture coords. Fixed upstream in
[xtermjs#6042](https://github.com/xtermjs/xterm.js/pull/6042), shipped in
`xterm 6.1.0-beta.289` / `addon-webgl 0.20.0-beta.288`.

We already hit this and papered over it:
[resize-handlers.ts:70](packages/claxedo-app/src/features/terminal/core/backend/resize-handlers.ts:70)
and [:158](packages/claxedo-app/src/features/terminal/core/backend/resize-handlers.ts:158)
call `clearTextureAtlas()` on every refresh, with a test pinning it
([resize-on-split.vitest.ts:402](packages/claxedo-app/src/features/terminal/core/resize-on-split.vitest.ts:402)).

#### F5. Font-settle refit waits on the wrong promise
We do `document.fonts.ready.then(() => backend?.fit())`
([terminal.tsx:308](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:308)).
`fonts.ready` resolves when *currently pending* loads settle — it can resolve
**before** a font that only xterm's canvas measurement will request has started
loading. xterm measures cell width at `terminal.open()`; if the real font
resolves later, cached glyph metrics diverge from what is drawn — "mangled text
that only repairs on the next resize" (their issue #4617).

Superset waits on `document.fonts.load(\`${fontSize}px ${fontFamily}\`)` for the
*specific* face, with a 2s timeout and a swallow so a poisoned spec can't block
recovery permanently, then refits — and re-runs it on every appearance change.

Our font stack is a 10-entry Nerd Font fallback list
([config.ts:4](packages/claxedo-app/src/features/terminal/core/config.ts:4)),
which makes late resolution *more* likely, not less.

#### F6. `fit()` is not gated on parser idleness
`fitAddon.fit()` → `terminal.resize()` → `WriteBuffer.flushSync()` re-enters the
parser synchronously, which is illegal while an async parser handler is paused,
and leaves the parser permanently FAILed ("improper continuation due to previous
async handler, giving up parsing") — the terminal is bricked until remount.
[resize-handlers.ts:41](packages/claxedo-app/src/features/terminal/core/backend/resize-handlers.ts:41)
has no gate.

Their `parser-idle-gate.ts` is 40 lines: wrap `terminal.write` once at creation
to count in-flight writes, run the resize immediately at zero, otherwise park it
until the count drops. Cheap insurance; we do not ship `@xterm/addon-image` (their
trigger) but any async OSC handler reintroduces it.

*Not a finding:* our `terminal-runtime-queue.ts` already batches writes per
animation frame with byte caps — comparable to their `write-coalescer.ts`. This
one we have.

### Tier 3 — Modes and input

#### F7. Mode restoration reads a stale client snapshot instead of live truth
This is the architectural root of the mouse-garbage bug, and it is bigger than
the `likelyTui` heuristic I flagged in revision 1.

**Ours:** a hand-rolled regex scanner
([mode-scan.ts](packages/claxedo-app/src/features/terminal/core/mode-scan.ts))
runs in the renderer, its output is serialized into localStorage at snapshot
time, and `rehydrateSequences()` replays that **stale snapshot** on the next
mount. Whether mouse/focus modes survive the filter is decided by
`filterModeSequences` keyed on `likelyTui`, which is a **title** match against
`/codex|claude|opencode|gemini|cursor/`
([reconnect-heuristics.ts:3](packages/claxedo-app/src/features/terminal/core/reconnect-heuristics.ts:3)).
A tab merely *named* "Claude" re-arms mouse tracking on every remount.

**Theirs:** `terminal-mode-tracker.ts` runs a **headless xterm on the server**,
fed every PTY output chunk synchronously via `_writeBuffer.writeSync`, and
`buildPreamble()` derives the byte sequence from **live** mode state at attach
time. If the TUI died, the tracker saw it; the preamble reflects reality. Notable
details worth copying:
- alt-screen toggles are excluded (the buffer restore owns that);
- `synchronizedOutputMode` is deliberately omitted — re-asserting it would
  suspend rendering until the next end-marker;
- kitty flags are restored with `CSI = N ; 1 u` (set effective state, not replay
  the program's push/pop stack);
- the private-internals surface is validated at construction so an
  `@xterm/headless` upgrade fails loudly instead of throwing inside every output
  callback.

We already depend on `@xterm/headless@6.1.0-beta.220` — but only in tests
(`core/integration/*.test.ts`). The dependency is there; the production use is not.

**Provenance.** Our `mode-scan.ts` is a port of their **v1** headless emulator
(`apps/desktop/src/main/lib/terminal-host/headless-emulator.ts`): the two
`MODE_MAP`s are identical across all 15 shared entries — same DECSET numbers,
same key names — and both carry the same "rehydration sequence generation"
concept. We added `1007`/`1047`.

The port landed on the wrong side of the wire. Theirs ran in Electron **main**,
mirroring live PTY output; ours runs as a regex scanner in the **renderer** whose
output is persisted to localStorage and replayed from a stale snapshot. Their v2
moved this to a live host-side tracker. So W5 is not patching a heuristic — it is
completing a migration they have already done, and the mouse-garbage bug is a
v1-architecture bug that the v2 shape structurally cannot have.

#### F8. No reclaimer for input modes leaked by a killed TUI
A TUI killed uncleanly — `kill -9`, a crash, or a self-update that exits, which
is exactly what the reported Codex repro shows — never writes its restore
sequences, so the reclaiming shell inherits kitty keyboard / mouse / focus. With
kitty leaked, every keystroke reaches the shell CSI-u encoded (`Ctrl+C` →
`^[[99;5u`) and the pane is unusable until `reset`.

Their `#5790` is a transport-agnostic decision core plus a thin xterm-parser
adapter. Correctness points from their doc:
- key on their **private** OSC marker, **not** FinalTerm `OSC 133;A` — 133;A is
  emitted by third-party shell integrations and forwarded by tmux, so disarming
  on it would clear a live tmux's own modes;
- modes armed **before the first prompt marker** are shell-owned and never
  reclaimed;
- mark-then-recheck on a microtask, so a TUI re-arming right after the prompt
  (`fg` after `^Z`, or a new TUI racing the prompt) keeps its modes;
- one `?1003l` clears the whole xterm mouse group (9/1000/1002/1003).

**Prerequisite:** we already emit `OSC 777;claxedo-shell-ready`, but ours is
**one-shot** — [zshlogin.template.sh](packages/workspace-runtime/src/agent-hooks/templates/zshlogin.template.sh)
removes itself from `precmd_functions` after the first prompt, and fish does
`functions -e` likewise
([agent-hooks/core/shell.ts:180](packages/workspace-runtime/src/agent-hooks/core/shell.ts:180)),
because it exists for initial-command readiness. Reclaim needs it on **every**
prompt without breaking readiness.

#### F9. Incoherent terminal identity
- `TERM=xterm-256color` ([pty/index.ts:398](packages/workspace-runtime/src/pty/index.ts:398)).
- `TERM_PROGRAM` is **passed through from the host** via the env allowlist
  ([pty/env.ts:70](packages/workspace-runtime/src/pty/env.ts:70)) — so agent TUIs
  see whatever launched Electron, often `Apple_Terminal`, often nothing.
- We never set `vtExtensions: { kittyKeyboard: true }`
  ([config.ts:21](packages/claxedo-app/src/features/terminal/core/config.ts:21)),
  so our xterm does not advertise the kitty keyboard protocol at all.

Superset sets a deliberate, stable identity (`kitty` / `0.42.0`) as a shared
constant used by both env builders, and enables `vtExtensions.kittyKeyboard`.

*Not a finding:* our Shift+Enter already sends `\x1b\r` directly
([xterm.ts:132](packages/claxedo-app/src/features/terminal/core/backend/xterm.ts:132)),
bypassing the kitty handshake — same approach as theirs.

#### F10. Wheel scrolling is a conservative fallback, not fidelity
Ours ([xterm.ts:82](packages/claxedo-app/src/features/terminal/core/backend/xterm.ts:82))
only acts when `alternateScroll || alternateScreen`, **bails entirely if any
mouse-tracking mode is on**, and emits arrows or PageUp/PageDown with a 40px
step and a 12-event burst cap.

Theirs converts pixels → lines at full fidelity with a fractional accumulator,
emits **one sequence per line**, and synthesizes proper SGR wheel reports with
per-cell column/row (so vim splits and tmux route the wheel correctly). It
deliberately diverges from xterm's `_consumeWheelEvent` in two ways — no 0.3x
trackpad damping, and no one-report-per-event cap — because of an xterm.js
regression (PR #5391). It refuses to synthesize when SGR encoding is not active,
since legacy X10 byte encoding breaks past column 223.

### Tier 4 — Lifecycle and restore

#### F11. Restored scrollback is wiped a second later
[terminal.tsx:954](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:954)
writes `\x1b[0m\x1b[H\x1b[2J` on socket open when
`likelyTui && (splitWidthChanged || wasReconnect)`.

`mountCols` is sampled at [terminal.tsx:327](packages/claxedo-app/src/features/terminal/ui/terminal.tsx:327)
— right after backend creation, **before** fonts settle and before any fit — so
it is the unfitted default while `snapshotCols` is the real prior width.
`splitWidthChanged` is therefore true on essentially every cold mount. Sequence
on restart: restore buffer (history flashes) → socket opens → screen cleared →
plain prompt. It hits exactly the Claude/Codex-titled tabs, because `likelyTui`
is a title match.

The clear exists so a **live** TUI redraws on SIGWINCH. After a restart the PTY
is new (F13) — there is nothing to redraw.

#### F12. xterm lifetime is bound to the component
Our xterm backend is created and disposed with the Solid component
(`cleanups.push(() => b.dispose())`), so every remount runs the full
serialize → localStorage → restore → cursor-replay → mode-rehydrate cycle. That
cycle *is* the machinery generating F7 and F11.

Superset decouples it: `createRuntime` builds the xterm once, `attachToContainer`
/ `detachFromContainer` move its wrapper between the live container and a hidden
body-level **parking** node (`inert`, `aria-hidden`, off-screen — so a parked
terminal's `<textarea>` can't steal keystrokes), and a registry keeps runtimes
addressable across mounts. On detach nothing is torn down; there is no restore
path to get wrong.

They pay for that with memory (~55–70 MB RSS per live runtime, measured) and
manage it with an LRU cap on **parked** runtimes, with two refinements worth
copying: runtimes in the **alternate screen are exempt** from eviction (in-place
TUIs restore as garbled snapshots), and eviction is **skipped entirely** if the
buffer cannot be persisted, rather than silently losing it.

#### F13. PTYs do not survive an app restart
PTYs are children of the claxedo-server sidecar, which
[main/index.ts:158](packages/claxedo-desktop/src/main/index.ts:158) kills on
`before-quit`.

A partial mitigation already exists and is worth finishing rather than replacing:
the server keeps disk history per PTY and reseeds a recreated session through
`env.previousPtyId` → `renameHistory` → `history.snapshot()`
([pty/index.ts:481-507](packages/workspace-runtime/src/pty/index.ts:481)), driven
by the client's `clone()` on WS close 1008
([terminal-content.tsx:247](packages/claxedo-app/src/features/terminal/ui/content/terminal-content.tsx:247)).
Note that this seed path runs straight into F3's truncation.

Live **TUI state** cannot be preserved without a detached PTY owner (W9).

#### F14. Dims not resynced on pane reveal
Our coordinator notifies only when fitted dims change, so a pane hidden while the
PTY was resized elsewhere returns desynced. Their `#5725` landed on notifying
**unconditionally** after any observer-driven fit (VS Code `setVisible → _resize`
parity) — a same-size `TIOCSWINSZ` delivers no SIGWINCH, so idle reveals stay
silent. Their first attempt tracked a reveal latch and they removed it as
unnecessary; take the second version.

---

## Work packages

### W1 — Byte-clean data path *(F1, F2, F3)*
Highest severity, entirely ours, no reference port needed beyond the shape.
1. Feed PTY output to xterm as `Uint8Array`; keep control frames JSON.
2. Make the replay cursor a single unit (bytes) on both ends, or drop cursor
   arithmetic in favour of their `?replay=0`-after-first-bytes model.
3. Convert the server FIFO and disk history to whole-chunk eviction; never slice
   within a chunk.

**DoD.** A PTY stream deliberately split mid-codepoint and mid-escape across
frames renders identically to an unsplit stream. Reconnect after 1MB of CJK/emoji
output replays the exact tail. Unit tests for all three at the boundary.

### W2 — Bump `@xterm/*` to the atlas-fix line *(F4)*
`@xterm/xterm`, `headless`, `addon-fit`, `addon-search`, `addon-serialize`,
`addon-unicode11`, `addon-clipboard` → `6.1.0-beta.289`; `addon-webgl` →
`0.20.0-beta.288`. **Hold `addon-ligatures` at `0.11.0-beta.220`** — its
beta.289 bundle inlines opentype.js 2.x, which imports `node:diagnostics_channel`
and breaks the Vite renderer build.

**DoD.** Four terminals with identical font/theme, one scrolling heavy output:
no glyph fragments in the others. Then, as a **separate** commit, remove the
`clearTextureAtlas()` workaround and re-verify.

### W3 — Font-settle refit *(F5)*
Replace `document.fonts.ready` with `fonts.load(\`${size}px ${family}\`)` +
timeout + swallow, and re-run it on appearance change.

**DoD.** Cold-start with a Nerd Font that is not yet cached: no mangled metrics,
no repair-on-first-resize.

### W4 — Parser-idle gate *(F6)*
Port `parser-idle-gate.ts` (~40 lines) and route every fit through it.

**DoD.** A resize during a paused async parser handler defers instead of throwing;
the terminal stays usable.

### W5 — Live mode truth + leaked-mode reclaim *(F7, F8)*
The larger port, and the one that actually fixes the mouse garbage.
1. Stand up a server-side headless-xterm mode tracker and build the reattach
   preamble from live state; retire `rehydrateSequences()` from the stale
   localStorage snapshot and the `likelyTui`-keyed `filterModeSequences`.
2. Port the reclaimer core + xterm adapter.
3. Make the `OSC 777` shell-ready marker repeat on every prompt without breaking
   one-shot initial-command readiness.

**DoD.** Their repro: run a kitty-keyboard TUI, `kill -9` it from another shell —
`Ctrl+C` interrupts and typing works with no `reset`. A live TUI keeps its modes.
A tab titled "Claude" running a plain shell produces no mouse reports.

### W6 — Don't clear a screen with no TUI to redraw *(F11)*
Skip the `\x1b[H\x1b[2J`, the mouse rehydrate, and the SIGWINCH double-toggle
when the PTY was just created (the `clone()` recovery path). Separately, stop
sampling `mountCols` before the first fit — a pre-font-load default makes
`splitWidthChanged` meaninglessly true and mis-drives four branches.

**DoD.** Restart with three terminals including Codex and Claude tabs: scrollback
stays. Splitting a pane with a live TUI still redraws.

### W7 — Wheel fidelity + terminal identity *(F9, F10)* — **ship as one change**
Port the wheel handler **and** set a deliberate identity (`TERM_PROGRAM=kitty`,
a version string, `vtExtensions: { kittyKeyboard: true }`) in the same commit,
with a test asserting the coupling. Shipping either alone reintroduces slow
(~1/3) or runaway (~3x) scrolling.

**DoD.** A 30-notch flick in a Claude Code transcript scrolls comparably to a
native terminal. Test fails if the identity is changed without the handler.

### W8 — Restored-session separator *(F13, partial)*
When a PTY is cold-restored rather than adopted, prepend a dim
`─── Session Contents Restored ───` ahead of the fresh shell's first output.
Take their follow-up commits too: keep the notice **out** of the bounded FIFO
(a >64KB pre-attach burst evicts the oldest chunk first — the notice), and bail
early when the attach socket is already closed so replay state survives.

### W9 — Parked runtimes / detached PTY daemon *(F12, F13)* — **deferred, sizing only**
Two independent architectural moves:
- **Renderer:** park xterm runtimes instead of disposing them (registry + LRU
  cap, alt-screen exempt, persist-guarded). Removes the restore path rather than
  fixing it.
- **Host:** a standalone PTY-owning process. Their README records two portability
  traps: node-pty 1.2's master fd handling is **incompatible with Bun**
  (`tty.ReadStream` closes immediately), and node-pty `1.1.0` leaks a `/dev/ptmx`
  descriptor per spawn on macOS — they pin `1.2.0-beta.14` and run the daemon
  under Electron's bundled Node.

**Not scheduled.** Decide after W1–W8.

---

## Sequencing

W1 first — it is the highest-severity finding, it is entirely ours, and F2/F3
sit underneath the restore paths that W6 and W8 touch. W2 next (independent,
biggest visible win per unit of risk). W3/W4 are small and independent. W5 is the
largest port. W6 depends on nothing but reads better after W1. W7 is a single
coupled commit. W8 depends on W6. W9 is a decision.

## Verification gate

Per [feedback_no_false_positive_verification], green tests are a claim, not
evidence. Every DoD above is a **live desktop repro** in addition to unit tests.
Terminal restore carries dense regression comments — nothing here lands on
test-green alone.
