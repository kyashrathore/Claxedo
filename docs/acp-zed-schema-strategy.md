# How Zed Handles ACP Schema Divergence — And What We Should Borrow

A reference on `zed-industries/zed`'s strategy for handling divergence in ACP
client-side schemas, paired with a concrete assessment of which pieces to adopt
in our adapter, which to skip, and what the tradeoffs are for our specific
shape (TS translator sitting over `@agentclientprotocol/sdk` 0.16.1, driving
three runners: Claude, Codex, Cursor).

**Companion doc.** Read `docs/acp-agent-vocabulary-mapping.md` first — this
doc assumes you know *what* diverges across agents. This one is about *how to
insulate the client from that divergence*.

**Scope.** Client-side protocol handling only — how we receive `session/update`,
how we send requests, how we survive a runner adding a new field or variant
between versions. Not a re-architecture of the translator.

---

## 1. Zed's architecture in one diagram

```
┌──────────────────────────────────────────────────────────┐
│  agent-client-protocol crate (Rust, co-maintained w/spec)│  ← owns schema
│  - typed structs per message                             │
│  - #[serde(default)] on optional fields                  │
│  - acp::Meta = typed bag for pre-stabilization keys      │
└────────────────────────┬─────────────────────────────────┘
                         │ imported as `acp`
┌────────────────────────▼─────────────────────────────────┐
│  crates/agent_servers/src/acp.rs (3467 lines)            │  ← connection
│  - Initialize handshake w/ MINIMUM_SUPPORTED_VERSION = V1│
│  - Capability-gated methods (load/close/resume/list)     │
│  - 8 request handlers + 1 notification dispatcher        │
│  - Ref-counted sessions, foreground dispatch queue       │
│  - Per-vendor shims inline (Gemini only, 2 places)       │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  crates/acp_thread/src/acp_thread.rs (5514 lines)        │  ← state machine
│  - `handle_session_update` single match over 11 variants │
│  - ContentBlock state machine (Empty → Markdown → ...)   │
│  - ToolCallStatus round-trip + internal-only states      │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  crates/acp_tools/src/acp_tools.rs (869 lines)           │  ← devtool
│  - Taps both directions + stderr                         │
│  - Inspector pane renders live JSON-RPC stream           │
└──────────────────────────────────────────────────────────┘
```

Four layers. Ours collapses three of them (schema, connection, state) into one
translator file and two sibling files. That collapse is the root cause of the
§10 drift in `acp-agent-vocabulary-mapping.md`.

---

## 2. Comparison table — feature by feature

| Concern                        | Zed                                              | Us                                              | Gap      |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------- | -------- |
| Protocol version floor         | `MINIMUM_SUPPORTED_VERSION = V1`, checked at initialize response | Not enforced                                    | **high** |
| Capability negotiation         | Reads `agent_capabilities.{load_session,session_capabilities.{list,close}}` + `prompt_capabilities` at runtime | `agentCapabilities` read once; no runtime gates | medium   |
| Schema source of truth         | Owns `agent-client-protocol` crate; typed structs end-to-end | SDK owns types; we operate on raw JSON in translator | structural |
| Forward-compat deserialization | `#[serde(default)]` on all optional fields; `_ => {}` catchall in match | Exhaustive switch with `const _: never`         | **opposite** — by design |
| `_meta` escape hatch           | 6 documented keys (tool_name, subagent_session_info, 3× terminal, terminal-auth) | Not consumed anywhere                           | **high** |
| Per-vendor workarounds         | Inline `if agent_id == GEMINI_ID` with TODO + PR link | `acp-registry.ts` (44 rules), registry-keyed    | ours better |
| Error handling                 | Branch on `ErrorCode` enum; only parse `err.data` as last resort for one specific bug | `map_acp_error` equivalent in `acp.ts`          | parity   |
| Unknown session/tool           | `log::warn!` + drop                              | Same pattern                                    | parity   |
| Terminal RPC                   | 5 dedicated methods (create/kill/release/output/wait) | Terminal via meta passthrough                   | low      |
| Ref-counted sessions           | `ref_count` on `AcpSession` and `PendingAcpSession`; `close_session` only on last drop | Tear down whole process per session             | **high** |
| Load buffering                 | Notifications pre-load response are replayed after | Unknown — not verified                          | unknown  |
| Concurrent loader protection   | `Shared<Task>` dedupes parallel loaders for same session | Unknown                                         | unknown  |
| Cancel bookkeeping             | `suppress_abort_err` flag distinguishes user-cancel from agent-cancel | Unknown                                         | medium   |
| Observability                  | `AcpLogTap` + `AcpConnectionRegistry` + inspector pane | Logs only                                       | medium   |
| Dispatch-queue isolation       | `Send` handlers → foreground `!Send` GPUI queue, with rejection path | N/A (single event loop, JS)                     | N/A      |
| Testing surface                | `FakeAcpAgentServer`, `FakeAcpConnectionHarness`, ~1200 lines | Unit tests per rule; no end-to-end fake agent   | medium   |

---

## 3. The five things that matter for us

Ranked by "severity of divergence pain today" × "cost to adopt".

### 3.1 Protocol version floor — ship this first

**What Zed does.** One const, one check at `acp.rs:393`, `:685`:

```rust
const MINIMUM_SUPPORTED_VERSION: acp::ProtocolVersion = acp::ProtocolVersion::V1;

if response.protocol_version < MINIMUM_SUPPORTED_VERSION {
    return Err(UnsupportedVersion.into());
}
```

**Why it's better.** Version pinning per runner (our §13 table) tells us
*what we verified*. A minimum check catches *what we didn't*. Today if a
runner reports protocol v0 or a pre-release, we'd keep going and fail on
whatever the first method shape mismatch is — a loud-but-wrong error.

**How we adopt.** Add `MINIMUM_ACP_PROTOCOL = 1` (or match spec naming) in
`packages/workspace-runtime/src/adapters/acp.ts` near the initialize call.
If `initializeResponse.protocolVersion < MINIMUM_ACP_PROTOCOL`, throw a typed
`UnsupportedProtocolVersionError`. Adapter surfaces it as a session-status
error instead of a cryptic JSON-RPC failure later.

**Pros**
- 20 lines of code. Zero ongoing maintenance.
- Fails fast with a legible error at process start, not mid-stream.
- Unblocks future "we only support protocol ≥ N" statements with confidence.

**Cons**
- New runners have to advertise a version we accept. If a runner pins a
  pre-release version number (e.g. `0.9`), we'd reject them; the registry
  would have to document the minimum.

**Effort**: half a day. **Risk**: trivial.

---

### 3.2 `_meta` passthrough — structural but cheap

**What Zed does.** Zed neither rejects nor generically passes `meta` — it
*reads specific keys* with `meta.get(key).and_then(...)` at six call sites,
then typed-decodes the value. Missing or wrong-type values fall through to
`None`, no errors. The keys are documented:

| Key                          | Carrier                 | Purpose                                |
| ---------------------------- | ----------------------- | -------------------------------------- |
| `tool_name`                  | `ToolCall.meta`         | Workaround: ACP has no tool-name field |
| `subagent_session_info`      | `ToolCall.meta`         | Nested session pointer                 |
| `terminal_info`              | `ToolCall.meta`         | Terminal creation hint                 |
| `terminal_output`            | `ToolCallUpdate.meta`   | Stream output                          |
| `terminal_exit`              | `ToolCallUpdate.meta`   | Exit status                            |
| `terminal-auth`              | `AuthMethod.meta`       | Legacy auth fallback                   |

**Why it's better.** `_meta` is the spec's sanctioned forward-compat channel.
The three runners we support today don't lean on it heavily, but Zed's
`tool_name` example is instructive: ACP's `ToolCall` doesn't carry the
programmatic tool name, so *Zed put it in `_meta`*. Our translator derives
intent from `rawInput` field-name heuristics (the 12-variant chain in §10
of the vocabulary mapping) — a fragile reconstruction of the same information.

**How we adopt.** Two moves:

1. **Read side.** In `translate-session-update.ts`, for every `ToolCall` and
   `ToolCallUpdate`, extract `update.meta` (if present) and forward it on the
   emitted event as `meta: Record<string, unknown>`. The registry can then
   promote specific keys to intent (`tool_name` → registry lookup by name
   rather than heuristics).

2. **Write side.** When we originate tool calls (client→agent, e.g. our own
   permission replies), put non-spec fields in `_meta` not at top level.

**Pros**
- Future-proofs against specced-later fields. When ACP 0.17 adds a new
  optional field that ships first in `_meta`, we inherit it for free.
- Makes `tool_name` extraction deterministic for agents that set it (Zed's
  convention; if we adopt the same key, we're compatible with any agent
  following Zed's pattern).
- Generic passthrough on debug events gives us free observability for keys
  we don't handle yet.

**Cons**
- We'd need to audit registry rules to check if any existing "intent from
  rawInput" heuristic is already overridden by a `_meta.tool_name` in practice.
  Probably none today, but checking takes a couple hours.
- Slightly more event surface area — every tool event grows a `meta?` field.

**Effort**: 1–2 days. **Risk**: low, additive change.

---

### 3.3 Capability gates at the call site, not at init time

**What Zed does.** Every optional method checks a capability flag *at call
time*, not at boot:

```rust
// crates/acp_thread/src/connection.rs trait defaults
fn supports_load_session(&self) -> bool { false }
fn supports_close_session(&self) -> bool { false }
fn supports_resume_session(&self) -> bool { false }

// crates/agent_servers/src/acp.rs
fn supports_load_session(&self) -> bool {
    self.agent_capabilities.load_session
}
fn supports_close_session(&self) -> bool {
    self.agent_capabilities.session_capabilities.close.is_some()
}

// Usage
if !self.agent_capabilities.load_session {
    return Task::ready(Err(anyhow!("load_session not supported")));
}
```

**Why it's better.** Our §2 table in `acp-agent-vocabulary-mapping.md` has a
"Our adapter calls it?" column. Those entries are *static facts about our
code*, not *runtime checks about what the peer supports*. If we call
`session/close` against an agent that doesn't advertise it, we learn via an
RPC error. Zed learns via a compile-time path that returns "not supported"
before the wire call.

**How we adopt.** In `acp-state.ts` (where we hold `agentCapabilities`),
surface typed getters: `supportsLoadSession()`, `supportsCloseSession()`,
`supportsResumeSession()`, `supportsSessionList()`. Every call site that
invokes an optional method checks first. Missing capability → the caller
gets a typed `CapabilityNotSupportedError`, not a generic RPC failure.

**Pros**
- Error messages say "runner X doesn't support session/close" instead of
  "RPC error -32601 method not found".
- Unblocks gap #1 in our vocabulary doc (session/close) — we can adopt it
  behind a gate, skip the call for runners that don't advertise it.
- Tests: mocking a "runner without close" becomes a one-line capability
  stub instead of a mock RPC error.

**Cons**
- Every new optional method needs a new getter. Mild boilerplate.
- Doesn't help if a runner *lies* in its capabilities. Zed has the same
  problem — no solution exists short of version-pinning.

**Effort**: 1 day. **Risk**: low.

---

### 3.4 Ref-counted sessions — enables the connection refactor

**What Zed does.** `AcpSession` and `PendingAcpSession` hold a `ref_count`.
Multiple callers can `load_session` the same ID; a `Shared<Task>` dedupes
the RPC. `close_session` decrements; only the last drop calls the wire method
(`acp.rs:278`, `:1368`, tested at `:2426` and `:2680`).

**Why it's better.** Today we tear down the whole process per session
(§12 gap #1). That's the *simple* model but it forecloses the
one-connection-many-sessions refactor everyone eventually wants. Zed spent
structural effort here because they need it for multi-thread workflows in
one editor window.

**How we adopt.** This is the biggest item on the list. Concretely:

1. Model `AdapterSession` with a ref-count, held by any subscriber (UI tab,
   recovery, eval CLI).
2. Change the adapter lifecycle from "one process per session" to "N sessions
   per process, bounded by the connection lifetime".
3. Add `supportsCloseSession()` gate (from §3.3) and call `session/close`
   on last drop when the capability is advertised.
4. Keep the old "kill the process" fallback for runners without close
   support.

**Pros**
- Connection reuse → faster session open (no process spawn per tab).
- Matches where ACP is heading — the spec keeps adding session-level primitives.
- Let us drop the `session_map` SQLite table for runners that implement
  `list_sessions` (Codex today).

**Cons**
- Non-trivial: this is the biggest refactor on this list. Touches lifecycle,
  recovery, DB, UI.
- Introduces a new failure mode: process dies with N live sessions. Need
  a clean fan-out-error path.

**Effort**: 1–2 weeks. **Risk**: medium — lots of surface area, but the
design is well-understood from Zed.

---

### 3.5 Inspector pane — cheapest long-term win

**What Zed does.** `crates/acp_tools/` is a 869-line developer-only pane
that taps both directions of every active ACP connection, renders each
JSON-RPC frame as expandable JSON, and keeps a ring buffer for replay.
Triggered by a command in the command palette.

**Why it's better.** Our §13 "How to keep this document honest" in the
vocabulary mapping doc admits we verify Cursor against docs and find drift
"by a test regression, not by a docs diff". An inspector means you find
drift in 30 seconds, live, against the actual runner.

**How we adopt.** Two options:

1. **Cheap.** Pipe all inbound/outbound JSON-RPC frames to a log channel
   behind a `CLAXEDO_ACP_TRACE=1` env var. No UI.
2. **Right.** New tab type (like our existing terminal/session tabs) that
   subscribes to a per-connection frame stream. Renders frames with
   expand/collapse, filter by method, search by session id.

Start with (1) this week. (2) can wait until it's painful enough.

**Pros**
- Surfaces `_meta` keys we don't handle, mismatched field names, unexpected
  variants — all the things §10 of the vocabulary doc is currently compiling
  by hand.
- Doubles as a bug-report artifact ("run with trace on, send me the log").

**Cons**
- Volume. ACP streams are chatty; the log will be noisy without filters.
  Put behind a flag.

**Effort**: 1 day for (1), 3–5 days for (2). **Risk**: trivial.

---

## 4. What we're *not* adopting and why

Not everything Zed does makes sense for us. Explicit non-goals:

### 4.1 Permissive deserialization (`_ => {}` catchall)

Zed's `handle_session_update` match ends with `_ => {}` — unknown variants
silently ignored. We use `const _: never = update` in
`translate-session-update.ts:473` — a compile-time error.

**Keep ours.** Zed can be permissive because the `agent-client-protocol`
crate they co-maintain gates what variants *exist at all*. We consume the
SDK and translate to our own event enum — we need a build error when the
SDK adds a variant we haven't charted. Our vocabulary doc §13 is explicit
that this is a design choice. Don't "fix" it.

### 4.2 Owning the schema crate

Zed literally co-maintains `agent-client-protocol`. We don't have that
leverage and shouldn't chase it.

**Alternative.** Lean harder on the SDK's typed surface. Every place in
`translate-session-update.ts` that reaches into `rawInput`/`rawOutput` as
`Record<string, unknown>` is tech debt. As the SDK types mature, replace
those accesses with `unknown` → parsed through a registry-owned Zod schema
per tool. This is what the hardening plan already calls out.

### 4.3 Inline per-vendor `if agent_id == GEMINI_ID` shims

Zed has two of these. They work because Zed only has ~3 runners it ships
with. Our registry (`acp-registry.ts`, 44 rules) already factors these out
cleanly. Keep the registry approach.

**Improvement.** Adopt Zed's *comment convention* for vendor rules: every
rule cites the upstream reason and a "remove-when" condition. Without that,
44 rules become 80 and nobody knows which are still needed.

### 4.4 Foreground dispatch queue

Zed has a `Send` → `!Send` bridge because GPUI is thread-pinned. JS has
one event loop; this problem doesn't exist for us.

---

## 5. Recommended order of operations

1. **Week 1**: Protocol version floor (§3.1) + trace logging (§3.5 option 1).
   Both small, both give immediate signal.
2. **Week 2**: Capability getters (§3.3). Unblocks §3.4 and closes the
   `session/close` gap gracefully.
3. **Week 3–4**: `_meta` passthrough (§3.2). Audit registry interaction.
   Add `meta` field to the translator's output events.
4. **Later** (separate planning doc): Ref-counted sessions (§3.4). The big
   one; do this when the connection-per-agent refactor is already on the
   roadmap, not as a standalone project.
5. **Opportunistically**: Inspector pane (§3.5 option 2). Ship when trace
   logs stop scaling.

Each step is independently valuable — no staircase dependency until §3.4.

---

## 6. Checklist — what to verify before starting

Answers to these determine whether the above estimates hold. Most are
"read the code for 20 minutes".

- [ ] Does `acp.ts` currently validate `initializeResponse.protocolVersion`
      against any minimum? (Expected: no.)
- [ ] Are notifications buffered between process spawn and initialize reply?
      (Zed has tested replay — we should verify.)
- [ ] Does any registry rule extract from `_meta` today?
      (`grep -r "meta" packages/workspace-runtime/src/adapters` should tell
      us in one command.)
- [ ] Does `pending_permission.always_json` actually get consulted on new
      permission requests? (Listed as gap #8 — verify before adopting §3.3,
      since the capability pattern assumes we respect the peer's advertised
      state.)
- [ ] Does `acp-state.ts` hold `agentCapabilities` in a stable shape that
      survives reconnect, or is it reset on process restart?
      (Affects §3.3's implementation — the getters need to cover the
      "not yet initialized" case.)

---

## 7. Open questions worth flagging

Things Zed has solved that we haven't decided on:

- **Cancel suppression.** Zed's `suppress_abort_err` flag elides the
  agent's own `StopReason::Cancelled` after a user-initiated cancel. We
  don't appear to distinguish these today — worth checking if cancellation
  surfaces as a user-visible error.
- **Typed `_meta` keys across agents.** If we standardize on Zed's keys
  (`tool_name`, `subagent_session_info`), we get cross-runner compatibility
  for free *if other runners also adopt Zed's conventions*. Worth raising
  in the ACP spec chat.
- **`list_sessions` vs our `session_map` SQLite.** Codex has it. Would we
  prefer agent-owned session enumeration? Trade-off: we lose offline listing
  but the agent is the source of truth.

---

## 8. Sources

- Zed `crates/agent_servers/src/acp.rs` — connection, handshake, handlers
- Zed `crates/acp_thread/src/acp_thread.rs` — state machine, SessionUpdate
  dispatch, ContentBlock/ToolCallStatus round-trip
- Zed `crates/acp_thread/src/connection.rs` — `AgentConnection` trait with
  `supports_*` defaults
- Zed `crates/acp_tools/src/acp_tools.rs` — inspector pane
- Our companion doc: `docs/acp-agent-vocabulary-mapping.md` (§10 drift table,
  §12 gaps)
- Our translator: `packages/workspace-runtime/src/adapters/translate-session-update.ts`
- Our state holder: `packages/workspace-runtime/src/adapters/acp-state.ts`
- Our connection: `packages/workspace-runtime/src/adapters/acp.ts`
