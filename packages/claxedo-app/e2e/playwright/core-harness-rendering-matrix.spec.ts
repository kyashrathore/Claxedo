/**
 * SPEC: Per-harness message-part rendering matrix
 *
 * PURPOSE — every harness family (opencode native, claude-acp, codex-acp, cursor-acp,
 * claude-sdk, codex-app-server, cursor-sdk, pi) ultimately streams its own raw event
 * shape into ONE canonical timeline. This spec proves that the timeline's dedicated
 * part renderers (`PART_MAPPING`/`ToolRegistry` in
 * packages/session-ui/src/components/message-part.tsx) are selected correctly no
 * matter which harness produced the part, and that harness-specific translation
 * quirks (name normalization, snapshot dedup, transport sentinels, fake tools) land on
 * the right visual outcome. Every other core-loop spec fixes the harness to
 * `opencode`; this is the one spec that varies it.
 *
 * STATE MODEL — a message's rendered parts live in the client SSE-fed store
 * (`data.store.part[messageID]`), populated by `message.part.updated` /
 * `message.part.delta` events over `/global/event`. Nothing here is harness-specific
 * at the STORE layer — by the time a part reaches the client it is already in the
 * `@opencode-ai/sdk/v2` `Part` shape (text | reasoning | tool | file | compaction |
 * patch | agent | step-*). The harness-specific work happens upstream, OUTSIDE this
 * app, in `@claxedo/agent-event-runtime`'s per-harness adapters
 * (`packages/agent-event-runtime/src/harnesses/{acp,claude,codex,cursor}`) which
 * translate each provider's raw wire events into `AgentRuntimeEvent`s, and the
 * `opencode-compat` projection (`.../src/projections/opencode-compat/projection.ts`)
 * which turns those into the exact `message.part.updated`/`.../delta` envelopes this
 * spec replays. Nothing in this app re-derives that translation; the client is a pure
 * function of the parts it receives. Fixtures for each harness are GENERATED (not
 * hand-invented) by `e2e/fixtures/generate-harness-fixtures.ts`, which runs the real
 * adapter + projection code over raw payloads harvested from
 * `packages/agent-event-runtime`'s own test suites, and commits the translated output
 * as JSON under `e2e/fixtures/harness-traces/<harness>.json`. This spec's job starts
 * AFTER that translation: replay the committed envelopes through the mock SSE stream
 * (`mock.emit(envelope.payload, envelope.directory)`,
 * `e2e/helpers/mock-runtime.ts`'s `emit` handle) and assert the DOM.
 *
 * ANATOMY (packages/session-ui/src/components/message-part.tsx unless noted) —
 *   `PART_MAPPING["text"|"reasoning"|"tool"|"compaction"|"file"]` — the 5 registered
 *     part-type components (message-part.tsx:1813,1924,1929,2041,2077 — each assigns the
 *     map directly; the exported `registerPartComponent` helper at :1020 still has ZERO
 *     call sites, verified by `grep -rn registerPartComponent`). CORRECTED (2026-07-25):
 *     this entry used to list only 4 and call `file` an unrendered gap — `file` was
 *     registered (and added to `message-timeline.data.ts:539`'s `renderableParts` set) as
 *     part of the same remediation the ADDENDUM below describes, and BEHAVIORS #6 is now
 *     a positive test. `renderable(part)` (message-part.tsx:791) hides a part entirely
 *     unless it is a non-empty text, a reasoning part with summaries ON, an unhidden
 *     tool, OR `PART_MAPPING[part.type]` exists — so `patch`/`agent`/`step-*` part types
 *     (still unregistered) remain silently dropped from the assistant timeline.
 *   `[data-component="text-part"]` / `[data-component="reasoning-part"]` — text and
 *     reasoning parts; reasoning is gated by `showReasoningSummaries`. CORRECTED
 *     (2026-07-25): session-ui's own PROP default is `true`
 *     (`session-turn.tsx:331`, `message-part.tsx:791` — `?? true`), but claxedo-app never
 *     lets that default apply: `message-timeline.tsx:634,1492` always passes
 *     `settings.general.showReasoningSummaries()`, whose default is `false`
 *     (`src/platform/settings/provider.tsx:120`). Reasoning summaries are therefore
 *     OPT-IN, and the reachable default path in this app is the HIDDEN one — the exact
 *     opposite of what this ANATOMY entry used to claim. A test that wants a reasoning
 *     part on screen must flip the setting on first; `enableReasoningSummaries()` below
 *     does it through the real settings UI (the setting is reactive, so already-streamed
 *     reasoning parts appear as soon as the dialog closes).
 *   `[data-component="tool-part-wrapper"]` — wraps every tool part; entirely absent
 *     (not just hidden) while `part.tool === "question"` and
 *     `state.status` is `"pending"`/`"running"` (`hideQuestion`, line ~1494).
 *     `todowrite` tool parts return `null` unconditionally (line ~1492) — never even a
 *     wrapper.
 *   `ToolRegistry` (`register`/`render`, line ~1438) — a plain string->component map
 *     keyed by EXACT, case-sensitive `part.tool`: `read, list, glob, grep, webfetch,
 *     websearch, task, bash, edit, write, apply_patch, todowrite, question, skill`.
 *     Any other `part.tool` string falls back to `GenericTool`
 *     (`packages/session-ui/src/components/basic-tool.tsx`, `icon="wrench"` unless
 *     the row is an MCP operation, which draws `icon="mcp"`; title interpolates
 *     the raw tool string verbatim).
 *   Per-tool DOM (all under `[data-component="tool-part-wrapper"]`):
 *     read/list/glob/grep: `[data-slot="basic-tool-tool-subtitle"]` (path/pattern),
 *       `[data-slot="basic-tool-tool-arg"]` (extra args) — hidden while pending.
 *     webfetch/websearch: `[data-slot="basic-tool-tool-subtitle"]` = literal
 *       url/query, hidden while pending.
 *     bash: `[data-slot="shell-submessage-value"]` = literal `input.command`, hidden
 *       while pending (`ShellSubmessage`).
 *     edit/write/apply_patch(single-file): `[data-slot="message-part-title-filename"]`
 *       = `getFilename(filePath)`, hidden while pending.
 *     apply_patch(multi-file, `metadata.files.length > 1`): renders an Accordion of
 *       `[data-slot="apply-patch-filename"]` rows instead.
 *     task: `[data-component="task-tool-card"]` with
 *       `[data-slot="basic-tool-tool-subtitle"]` = `input.description`. The host's
 *       durable subagent registry associates the tool `callID` with a subagent through
 *       an explicit spawn edge. A ready child Session renders inside an `<a>` trigger;
 *       `transcript: {kind:"none"}` renders an explicit unavailable subtitle and no
 *       navigation control. Provider ids and transcript refs remain opaque identity,
 *       not navigation targets.
 *     question: `[data-component="question-answers"]` with
 *       `[data-slot="question-answer-item"]` rows, rendered ONLY once
 *       `state.metadata.answers.length > 0` (`completed()`, line ~2527) — the outer
 *       wrapper is absent before that per `hideQuestion` above.
 *     skill: title = `input.name` verbatim (no translation) when present.
 *     GenericTool (unknown `tool`): `[data-slot="basic-tool-tool-title"]` contains the
 *       raw tool string; `[data-slot="basic-tool-tool-subtitle"]` = first of
 *       description/query/url/filePath/path/pattern/name in `input`.
 *   `[data-component="compaction-part"] [data-slot="compaction-part-divider"]` — the
 *     `compaction` part-type divider (distinct from `session-turn.tsx`'s own
 *     user-message-scoped `[data-slot="session-turn-compaction"]` divider, which reads
 *     `message.summary`/a `compaction` part on the TRIGGERING USER message, not this
 *     one — see OUT OF SCOPE).
 *
 * BEHAVIORS —
 *   1. Text parts (paced markdown) render per harness, verbatim content, and a
 *      `message.part.updated(text:"")` + N x `message.part.delta` sequence ACCUMULATES
 *      into exactly the concatenated text — once, with no re-appended prefix.
 *      SCOPE CORRECTION (2026-07-25): several tests label this "cumulative-snapshot
 *      dedup". It is not — see the FIXTURE-PRE-BAKING note under HARNESS NOTES. The
 *      snapshot->delta conversion happens UPSTREAM in the adapter; the committed
 *      fixtures already carry post-dedup INCREMENTAL deltas, so what the replay proves is
 *      the client's delta accumulation, not the dedup itself.
 *   2. Reasoning parts render once `settings.general.showReasoningSummaries` is turned
 *      ON. That setting DEFAULTS TO FALSE in this app (provider.tsx:120), so the
 *      out-of-the-box path is the hidden one; the test flips it through the real settings
 *      UI before asserting the `[data-component="reasoning-part"]` renderer — see ANATOMY.
 *   3. Each registered ToolRegistry renderer (read, list, glob, grep, webfetch,
 *      websearch, task, bash, edit, write, apply_patch, skill) renders via its
 *      dedicated component for a part carrying that exact `tool` string.
 *   4. An unregistered `tool` string falls back to `GenericTool` (wrench icon, raw name
 *      in the title) — proven both via a deliberately-unknown name AND via harnesses
 *      whose native (non-ACP) tool names don't happen to match the registry (Claude
 *      SDK's `"Grep"`, Codex app-server's `"command"`, Cursor SDK's `"shell"`).
 *   5. A tool part's `state.status` transitions pending -> running -> completed (or
 *      -> error) and the DOM reflects each stage (pending: no subtitle/detail;
 *      running: same as pending visually for most tools; completed: detail visible;
 *      error: `ToolErrorCard` instead of the tool body).
 *   6. `file`-type parts (image/audio data-url, resource links) on ASSISTANT messages
 *      reach `FilePartDisplay` (`PART_MAPPING["file"]`, message-part.tsx:2077): an image
 *      renders an inline `img[data-slot="file-part-image"]`, audio an
 *      `audio[data-slot="file-part-audio"]`, and anything else a resource-link row
 *      (`a[data-slot="file-part-link"]` + `[data-slot="file-part-link-name"]`).
 *      CORRECTED (2026-07-25): this entry used to read "NO renderer in this app today —
 *      REAL GAP, not exercised as a pass". That gap was closed (see the ADDENDUM); the
 *      test below is a positive assertion, not an absence assertion.
 *   7. A `compaction`-type part renders `MessageDivider` inline in the assistant
 *      timeline.
 *   8. A `session.diff` SSE event is consumed into a separate diff query cache
 *      (`directory-event-projector.ts`), NOT into `data.store.part`/`message` — it
 *      must never create a phantom timeline row.
 *   9. `todowrite` tool parts NEVER render a tool row, on every harness (Claude
 *      SDK intercepts `TodoWrite` before any tool-start; Cursor SDK intercepts
 *      `updateTodos`; every ACP family intercepts its title/name variant) — only
 *      `todo.updated` reaches the client, which this spec proves does not add a row
 *      (the todo dock itself is `core-docks`' territory).
 *  10. `question` tool parts are absent from the DOM while pending, and render
 *      `[data-component="question-answers"]` once `state.metadata.answers` exists.
 *  11. Codex's proposed-plan stream (`item/plan/delta` / `item/completed(type:"plan")`)
 *      renders as ordinary paced text — deliberately no plan part/dock exists.
 *  12. Codex ACP's fake "Permission" tool_call becomes a `permission.asked` event and
 *      renders `SessionPermissionDock`
 *      (`src/pages/session/composer/session-permission-dock.tsx`,
 *      `[data-slot="permission-header-title"]`) — NEVER a `[data-component=
 *      "tool-part-wrapper"]` row.
 *  13. Cursor ACP's cumulative full-text snapshot chunks (raw `"A"` then `"A1"`,
 *      `generate-harness-fixtures.ts:317-318`) are de-duplicated by the ACP adapter into
 *      incremental deltas (`'A'`, `'1'`) BEFORE they ever reach this app — the committed
 *      `cursor-acp.json` carries the deltas, not the snapshots (inspect it: two
 *      `message.part.delta` envelopes). What the replay proves is therefore the CLIENT
 *      half: those deltas accumulate to `"A1"` exactly once, with no `"AA1"`. The dedup
 *      itself is an `agent-event-runtime` concern and is covered by that package's own
 *      tests — see the FIXTURE-PRE-BAKING note under HARNESS NOTES.
 *  14. Cursor ACP's `"Error: RetriableError: WritableIterable is closed"` transport
 *      tail is swallowed. CORRECTED (2026-07-25): the swallow happens UPSTREAM, in
 *      `isCursorWritableIterableTail`
 *      (`packages/agent-event-runtime/src/harnesses/acp/translate-session-update.ts:152,
 *      216-223`, which returns `null` for that exact chunk) — NOT in this app, which
 *      faithfully renders whatever parts it is handed. The generator DOES feed the raw
 *      chunk through the real adapter (`generate-harness-fixtures.ts:324`), so the
 *      discriminating evidence is that the TRANSLATED trace this spec replays contains no
 *      trace of the sentinel at all. The test asserts that on the loaded trace; the old
 *      `expect(page.getByText("WritableIterable is closed")).toHaveCount(0)` was VACUOUS
 *      (the string is absent from the fixture, so it also passed on a blank page). It is
 *      kept only as a corollary.
 *  15. Cross-harness subagent task parts resolve only through explicit host-owned spawn
 *      edges. OpenCode native, Claude native/ACP, Codex native, valid Cursor native,
 *      and model-backed Pi foreground/background rows progress Working -> Completed and
 *      open a read-only child transcript without replacing the parent. Codex ACP,
 *      Cursor ACP, and invalid Cursor native rows say `Transcript unavailable` and
 *      expose no navigation control. Bare Pi creates no synthetic task card, and an
 *      unauthorized parent-scoped runtime stream is rejected before subscription.
 *      Wide layouts preserve parent and child panes together; a narrow layout shows
 *      explicit read-only copy instead of a composer, and Back restores focus to the
 *      originating spawn card.
 *  16. Per-client tool NAME normalization: Cursor/Claude/Codex ACP's `"Terminal"`
 *      title -> `bash`. SCOPE CORRECTION (2026-07-25): that mapping is performed
 *      UPSTREAM by `harnesses/acp/registry.ts`, and the committed ACP fixtures already
 *      carry the NORMALIZED names (`cursor-acp.json`/`claude-acp.json` contain
 *      `part.tool: "bash"`, `"read"`, `"task"`; `codex-acp.json` contains `"edit"` — no
 *      `"Terminal"`/`"Read File"`/`"Update TODOs"` string survives into the fixture).
 *      What the replay proves is the OTHER half — that a part carrying the canonical
 *      lowercase name reaches the matching dedicated ToolRegistry renderer — not the
 *      normalization step. See the FIXTURE-PRE-BAKING note under HARNESS NOTES.
 *      A companion, source-verified FINDING (not a failure — pinned
 *      as real, documented behavior): Codex ACP's `apply_patch` tool_call resolves to
 *      the generic `edit` renderer, not the dedicated `apply_patch` one, because
 *      `harnesses/acp/state.ts`'s `pick()` unconditionally overwrites
 *      `short = "edit"` whenever `intent === "edit"` (line ~496), AFTER the registry
 *      already set `short: "apply_patch"` — the dedicated `apply_patch` renderer is
 *      only reachable via opencode's own native `apply_patch` tool name, proven
 *      separately in this spec's opencode-native scenario.
 *  17. `runtime.diagnostic` events (unmapped provider events) never add a timeline row
 *      of any kind.
 *
 * INVARIANTS — inherits `e2e/INVARIANTS.md` #1 (harness ownership — not this spec's
 *   concern, see OUT OF SCOPE) and #2 (completed content never hidden by stale busy —
 *   every scenario here injects parts onto an ALREADY-settled assistant message, so
 *   this invariant is implicitly exercised on every send).
 *
 *   DECLARED DEVIATION from `e2e/INVARIANTS.md` "Authoring rules" #2 (per that file's
 *   "a spec that needs to violate one must say so explicitly in its own SPEC block's
 *   INVARIANTS section, with a reason", INVARIANTS.md:60-61) — added 2026-07-25, because
 *   this deviation was previously undeclared:
 *     Rule #2 bans `page.locator('[data-slot="session-turn-assistant-content"]')
 *     .getByText(...)` as a substitute for the `expectAssistantReplyVisible` oracle. This
 *     spec DOES use that shape (via `assistantContent()` =
 *     `SELECTORS.assistantContentVisible`, the oracle module's own exported selector)
 *     for essentially every fixture assertion below.
 *     WHY THE ORACLE DOES NOT APPLY: `expectAssistantReplyVisible(page, text)`
 *     (`e2e/helpers/turn-oracle.ts:153`) is a REPLY-TEXT oracle. It asserts that a
 *     *turn-level assistant reply* is visible, and its whole point is catching the class
 *     of bug where a reply never renders. Nothing this spec asserts is a reply: the
 *     subjects are per-PART renderer outputs — a tool subtitle
 *     (`[data-slot="basic-tool-tool-subtitle"]`), a shell command value, a filename slot,
 *     a task card, a reasoning accordion's body, a compaction divider, the ABSENCE of a
 *     `todowrite` row. The oracle has no vocabulary for any of these, and routing them
 *     through it would either assert the wrong thing or require widening the shared
 *     helper (a change this spec's phase forbids).
 *     WHAT THIS SPEC STILL OWES THE ORACLE: the one genuine assistant REPLY in each
 *     scenario — the priming turn's `ack 1: <prompt>` — IS asserted through
 *     `expectAssistantReplyVisible` (`primeHarness`, line ~532 below), so the
 *     "reply never rendered" failure mode the rule exists to catch is still covered
 *     before any part-level assertion runs. Part-level assertions are additionally
 *     scoped to `assistantContentVisible` (the `:not([aria-hidden="true"])` variant), so
 *     they cannot pass against an aria-hidden/offscreen duplicate row.
 *     REMEDIATION PATH (not taken here): extend `turn-oracle.ts` with a part-level
 *     oracle (e.g. `expectAssistantPartVisible(page, {slot, text})`) and migrate this
 *     spec onto it — a shared-helper change, out of scope for this pass.
 *
 *   Spec-local invariant: the
 *   rendering matrix is a pure function of `part.type`/`part.tool`/`state.status` —
 *   it must not depend on which harness produced the part once the part has reached
 *   the client store (this is what makes one shared PART_MAPPING/ToolRegistry safe
 *   across 8 harness families).
 *
 * HARNESS NOTES —
 *   FIXTURE PRE-BAKING (added 2026-07-25; the single most important limit on what this
 *   spec can prove). This spec replays TRANSLATED envelopes — the output of the real
 *   adapter + `opencode-compat` projection, as committed under
 *   `e2e/fixtures/harness-traces/`. Every transformation that happens INSIDE that
 *   translation is therefore already applied in the committed JSON, and replaying it
 *   cannot re-prove it. Concretely, verified by inspecting the fixture files:
 *     - SNAPSHOT DEDUP (behaviors 1/13): the raw inputs in `generate-harness-fixtures.ts`
 *       are cumulative snapshots (`"A"`/`"A1"` at :317-318; `"Hel"`/`"Hello there"` at
 *       :350-351; `"Building the "`/`"Building the feature now."` at :155,160). The
 *       committed fixtures contain the POST-dedup INCREMENTAL deltas (`'A'`+`'1'`,
 *       `'Hel'`+`'lo there'`, `'Building the '`+`'feature now.'`). The replay proves the
 *       client accumulates deltas without re-appending a prefix; it does NOT prove the
 *       adapter's snapshot dedup.
 *     - TOOL-NAME NORMALIZATION (behavior 16): the committed ACP fixtures carry only
 *       canonical lowercase `part.tool` values (`bash`/`read`/`task`/`edit`) — the raw
 *       `"Terminal"`/`"Read File"`/`"Update TODOs"` titles never appear. The replay
 *       proves canonical-name -> renderer dispatch; it does NOT prove the registry's
 *       name mapping.
 *     - TRANSPORT-SENTINEL SWALLOW (behavior 14): the sentinel is absent from the
 *       fixture entirely, so no DOM assertion about it can discriminate anything (see
 *       behavior 14 for what the test asserts instead).
 *   Closing these gaps requires either regenerating fixtures with pre-translation
 *   payloads or asserting in `packages/agent-event-runtime`'s own suite (where
 *   `harnesses/acp/event-translator.test.ts` already covers the sentinel and the
 *   snapshot->delta conversion). Both are OUT OF SCOPE for this spec, which is forbidden
 *   from editing fixtures.
 *
 *   ACP families (claude-acp/codex-acp/cursor-acp) route every tool_call
 *   through `harnesses/acp/registry.ts`'s per-client rule table, which assigns a
 *   canonical lowercase `short` name (behavior 16) — this is why ACP tool names are
 *   consistently normalized. Native SDK families (claude-sdk/codex-app-server/
 *   cursor-sdk) have NO such registry — `projection.ts` passes the provider's raw tool
 *   name straight through (verified: zero `toLowerCase()`/name-map calls in
 *   `projections/opencode-compat/projection.ts` for tool names), so their builtin
 *   tools (Claude's `"Grep"`/`"Task"`, Codex's `"command"`/`"file-change"`, Cursor's
 *   `"shell"`) mostly fall to `GenericTool` — this is real, current behavior, not a
 *   bug this spec works around. `opencode` (native) and `pi` have no
 *   `agent-event-runtime` adapter at all (confirmed: no `harnesses/opencode` or
 *   `harnesses/pi` directory exists) — their SSE events already ARE the target
 *   `Part` shape, so their fixture is authored directly as that shape (see
 *   `generate-harness-fixtures.ts`'s documented exception) rather than derived from a
 *   translation step; `pi`'s renderer scenario is deliberately reduced (text + one
 *   tool) since it shares the identical native rendering path. Subagent scenarios below
 *   extend the shared mock with host-shaped `GET /session/:parent/subagents` rows,
 *   child Session/message endpoints, and canonical runtime-event envelopes. Tool-to-
 *   child correlation therefore uses the production contract: explicit
 *   `toolCallEdges`, a host-minted `childSessionId`, and no fixture-injected session
 *   metadata or title matching.
 *
 * OUT OF SCOPE — harness selection/ownership/model/effort UI
 *   (`core-harness-ownership-local`/`-cloud`); the permission/question/todo DOCK
 *   interaction (Allow/Deny, answering, dock open/collapse — `core-docks` owns the
 *   dock; this spec only proves Codex's fake-Permission-tool routing reaches the dock
 *   component at all, behavior 12); the per-turn diff ACCORDION driven by
 *   `message.summary.diffs` and `session-turn.tsx`'s own compaction divider
 *   (`core-timeline-rendering-scroll`); tool-part expand/collapse defaults
 *   (`core-timeline-rendering-scroll`). CORRECTED (2026-07-25): `file`-type assistant
 *   parts are NO LONGER out of scope and are no longer "asserted ABSENT (a real gap)" —
 *   behavior 6 gives them positive rendering coverage. Still genuinely uncovered:
 *   `patch`/`agent`/`step-*` part types, which have no registered component.
 *
 * REMEDIATION ADDENDUM (2026-07-10, verified-green pass) — two real, source-verified
 * rendering behaviors this file's tests now account for, not previously documented
 * above:
 *   - Consecutive "context" tools (`read`/`glob`/`grep`/`list` — `CONTEXT_GROUP_TOOLS`,
 *     message-part.tsx ~line 614) render grouped under ONE `ContextToolGroup`
 *     collapsible (`[data-component="context-tool-group-trigger"]`/`[data-component=
 *     "context-tool-group-list"]`, ~line 1057), closed by default, EVEN for a single
 *     tool — an "Explored N read, N search, N list" summary line, not each tool's own
 *     always-visible subtitle. Tests that need a grouped tool's subtitle/arg click the
 *     trigger open first.
 *   - `ToolErrorCard` (packages/session-ui/src/components/tool-error-card.tsx) is ALSO
 *     closed by default (`defaultOpen ?? false`) — a tool part's `state.error` detail
 *     text is not in a visible DOM node until its own `Collapsible.Trigger` is expanded.
 *   The assistant-timeline `compaction` divider (behavior 7), the claude-sdk `reasoning`
 *   part (behavior 2/17), and assistant `file`-type parts (behavior 6) were previously
 *   deferred; live store inspection root-caused all three (compaction/file dropped in the
 *   raw-Part<->UIMessage projection; reasoning gated behind the opt-in
 *   `showReasoningSummaries` setting) and they are now covered by real tests — see each
 *   test's inline note.
 *   `e2e/fixtures/harness-traces/pi.json` carries its tool envelope — 4 envelopes:
 *   a text part, its delta, a reasoning part, and a `completed` `read` tool part — which
 *   the "pi — one dedicated tool renderer (config.json subtitle)" test below asserts
 *   against directly.
 */
import { expect, test, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  installMockRuntime,
  type MockRuntimeChildSession,
  type MockRuntimeHandles,
  type MockRuntimeSubagentRow,
} from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "harness-traces")

type Envelope = { directory: string; payload: unknown }

/**
 * ACP-family fixtures (claude-acp/codex-acp/cursor-acp — verified via
 * `python3 -c "..." | sort -u` over every `messageID` field in each committed
 * `e2e/fixtures/harness-traces/<harness>.json`) carry a MIX of two message
 * IDs: `msg_assistant_1` (correctly stamped on `message.completed`/
 * `todo.updated`-type envelopes) and the ACP adapter's OWN internally
 * generated id, literally `"message-1"` (on every real `message.part.*`
 * envelope — the translation this spec exists to replay verbatim, so this is
 * NOT something to "fix" at the generator/translation layer). Native-SDK
 * fixtures (claude-sdk/codex-app-server/cursor-sdk) and the hand-authored
 * opencode/pi fixtures use `msg_assistant_1` uniformly and are unaffected.
 * Since the client attaches parts to the assistant row by exact `messageID`
 * match against the row `installMockRuntime`'s `driveTurn` already created
 * during priming (the FIXTURE FILES use `msg_assistant_1` uniformly —
 * `generate-harness-fixtures.ts`'s `identity()` documents that convention —
 * while driveTurn's live row id follows the production `${userMessageID}_r`
 * convention, exposed as `mock.requests.promptBodies[n].assistantID`), a part
 * carrying any OTHER `messageID` orphans it — it is parsed and accepted by
 * the client (confirmed via network trace: 200, correct JSON) but never
 * attaches to any rendered row, so the whole trace is silently invisible.
 * Remapped HERE, in-memory, at load time — never hand-editing the committed
 * fixture JSON (DoD #4's "a script regenerates them; hand-edited fixtures are
 * rejected" governs the FILES, not this in-memory replay adaptation).
 */
function remapMessageIds<T>(value: T, canonicalId: string): T {
  if (Array.isArray(value)) return value.map((item) => remapMessageIds(item, canonicalId)) as never
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "messageID" && typeof v === "string" && v !== canonicalId ? canonicalId : remapMessageIds(v, canonicalId)
    }
    return out as never
  }
  return value
}

function loadTrace(harness: string, assistantId: string): Envelope[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${harness}.json`), "utf-8"))
  const envelopes: Envelope[] = Array.isArray(raw) ? raw : (raw.envelopes ?? raw.main ?? [])
  return remapMessageIds(envelopes, assistantId)
}

function loadFixtureFile(harness: string, assistantId: string): Record<string, unknown> {
  return remapMessageIds(JSON.parse(readFileSync(join(FIXTURES_DIR, `${harness}.json`), "utf-8")), assistantId)
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

// ---------------------------------------------------------------------------
// SPEC-LOCAL WORKAROUND (shared-helper gap, mock-runtime.ts edits forbidden in
// this pooled phase — see e2e/INVARIANTS.md "Authoring rules" #1 and the finding
// filed for this spec's remediation).
//
// Root cause (source-verified, two layers):
//  1. `installMockRuntime`'s EventBus/`emit()` only backs `**/global/event?**`/
//     `**/event?**` (`e2e/helpers/mock-runtime.ts`'s `eventStreamHandler`). But
//     in the CURRENT app, ANY session with a `directory` set — every seeded
//     local session, not just cloud ones — has its `/global/event` fetch
//     REWRITTEN by `createControlPlaneEventFetch`
//     (`src/context/global-sdk-event-fetch.ts` lines 54-98: `hosting:
//     "workspace"` is unconditional once `session?.directory` is truthy) into a
//     request against `/api/wr/events` on the workspace's loopback origin
//     (`http://127.0.0.1:3001` by default, `src/index.tsx:96`) — confirmed via
//     Playwright network trace (zero `/global/event` requests; `/api/wr/events`
//     fires instead). Downstream parsing is unchanged
//     (`compatEventEnvelope(item)`, `src/context/global-sdk.tsx` ~line 720) —
//     the identical `{directory, payload}` SSE envelope shape `mock-runtime.ts`
//     already produces for `/global/event`.
//  2. `/api/wr/events` has TWO INDEPENDENT pollers: `global-sdk.tsx`'s main
//     event loop (the one that actually calls `enqueue()`/updates
//     `data.store`) AND `src/providers/claxedo-events.tsx`'s "central"
//     notification stream (pty/process/worktree events only —
//     `ClaxedoEvent` union, `isClaxedoEvent()` loosely accepts ANY
//     `{type: string}` shape at runtime, so it happily "accepts" this spec's
//     `message.part.*` envelopes then silently drops them — no handler is
//     registered for those types, `on()`/`emit()` ~line 90-110). A naive
//     drain-once queue (as `mock-runtime.ts`'s own EventBus does) hands the
//     WHOLE batch to whichever poller's `fetch` happens to land first — if
//     `claxedo-events.tsx` wins the race even once, it silently eats the batch
//     and `global-sdk.tsx`'s loop never sees it, producing a confirmed-delivered
//     (200, correct JSON body) but functionally invisible SSE payload. Fixed
//     below with an append-only log + `Last-Event-ID`-keyed cursor per
//     connection (mirrors real SSE resumption semantics,
//     `sseJsonStream`/`onEventId` in `global-sdk.tsx`), so EVERY poller sees
//     EVERY event exactly once, independent of which one asks first.
// `/api/wr/runtime-events` is the separate canonical runtime channel. The
// shared mock mounts it directly; U13 sends raw contract-versioned
// `subagent-updated` envelopes there while ordinary translated parts continue
// through this compat bridge.
type SpecEvent = { directory: string; payload: unknown }

function createSpecEventLog() {
  const log: SpecEvent[] = []
  let waiters: Array<() => void> = []
  return {
    push(event: SpecEvent) {
      log.push(event)
      const fire = waiters
      waiters = []
      for (const resolve of fire) resolve()
    },
    /** Returns events after `sinceId` (0-based count already seen), waiting up to `idleTimeoutMs` for at least one new one. */
    async since(sinceId: number, idleTimeoutMs: number): Promise<SpecEvent[]> {
      if (log.length <= sinceId) {
        await Promise.race([
          new Promise<void>((resolve) => waiters.push(resolve)),
          new Promise<void>((resolve) => setTimeout(resolve, idleTimeoutMs)),
        ])
      }
      return log.slice(sinceId)
    },
  }
}

/**
 * Mounts a spec-local `/api/wr/events` handler (any origin) backed by an
 * append-only log with a per-connection `Last-Event-ID` cursor (see the block
 * comment above for why a simple drain-once queue silently loses events to a
 * second, unrelated poller), and returns an `emit` function that feeds BOTH
 * that log and the original `mock.emit` (harmless belt-and-suspenders in case
 * anything still listens on `/global/event`).
 */
async function installWorkspaceRuntimeEventsBridge(page: Page, mock: MockRuntimeHandles) {
  const log = createSpecEventLog()
  await page.route("**/api/wr/events**", async (route) => {
    const lastEventId = Number(route.request().headers()["last-event-id"] ?? "0") || 0
    const events = await log.since(lastEventId, 4000)
    const body = events.length === 0
      ? ": heartbeat\n\n"
      : events.map((e, i) => `id: ${lastEventId + i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join("")
    await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
  })
  return (payload: unknown, directory?: string) => {
    const dir = directory ?? mock.session.dir
    log.push({ directory: dir, payload })
    mock.emit(payload as never, dir)
  }
}

const PROJECT_ID = "proj_harness_rendering_matrix"

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript(({ dir, projectId }: { dir: string; projectId: string }) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ id: projectId, worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, { dir, projectId: PROJECT_ID })
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

/**
 * Filters `mock.requests.console` down to genuine page-level errors, matching the
 * convention already established by `core-boot-deep-links-home.spec.ts`'s
 * `nonClerkConsole`. This app runs an always-on, session-independent central-relay
 * connection (`src/context/global-sdk.tsx`'s "central" stream, `src/providers/
 * claxedo-events`) that defaults to `http://127.0.0.1:3001` (`src/index.tsx:96`) when
 * no real backend is present — `installMockRuntime`/`seedOneProject` mock only the
 * session-scoped routes on the page's own origin, not this independent background
 * probe, so it legitimately logs "Failed to load resource"/connection-refused noise
 * in every Tier M spec that doesn't run a real backend. That noise is not this
 * spec's concern (behavior 8 only cares whether `session.diff` adds a phantom
 * timeline row); a real rendering exception still surfaces as an uncaught
 * `pageerror:` entry, which this filter does NOT swallow.
 */
function nonBackgroundNoiseConsole(entries: string[]) {
  return entries.filter(
    (item) =>
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_CONNECTION_REFUSED") &&
      !item.includes("[global-sdk]") &&
      !item.includes("[claxedo-events]"),
  )
}

/**
 * Establishes ONE oracle-proven turn (per `e2e/INVARIANTS.md`'s #1 rule) for a given
 * harness, then returns the mock handle so the test can layer the harness's real
 * translated trace ONTO that already-settled assistant message. The returned
 * `assistantId` is driveTurn's live row id for the primed turn
 * (`${userMessageID}_r`, production convention) — pass it to
 * `loadTrace`/`loadFixtureFile` so fixture parts attach to that row.
 */
async function primeHarness(
  page: Page,
  harness: string,
  subagents?: {
    rows: MockRuntimeSubagentRow[]
    children?: MockRuntimeChildSession[]
    runtimeEventAuthorizeParent?: (parentSessionId: string) => boolean
  },
): Promise<{
  mock: MockRuntimeHandles
  dir: string
  sessionId: string
  assistantId: string
  assistantInfo: Record<string, unknown>
}> {
  const dir = `/tmp/e2e-core-harness-rendering-matrix-${harness}`
  const sessionId = `ses_harness_matrix_${harness}`
  const mock = await installMockRuntime(page, {
    dir,
    sessionId,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    harness: harness as never,
    ...(subagents ? {
      subagents: { [`ses_harness_matrix_${harness}`]: subagents.rows },
      childSessions: subagents.children,
      runtimeEventAuthorizeParent: subagents.runtimeEventAuthorizeParent,
    } : {}),
    // Pin opencode to a concrete model instead of the mock default `big-pickle`
    // placeholder. The reworked composer (see `core-docks.spec.ts`'s identical
    // `establishSession` note) defers/redirects the very first send while only the
    // `big-pickle` placeholder model is resolved, which lets the legacy
    // `/<b64dir>/session` -> `/w/<workspaceId>` redirect win the race so the create
    // POST never targets the draft directory and the mocked session is never created
    // (the URL then settles on the workspace-root `/w/<workspaceId>` with no session pane).
    // Every other harness already defaults to a concrete model, so this only affects
    // opencode. Matches the canonical send-flow convention in
    // `core-first-prompt-local.spec.ts`.
    ...(harness === "opencode" ? { harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] } } : {}),
  })
  await seedOneProject(page, dir)

  const bridgedEmit = await installWorkspaceRuntimeEventsBridge(page, mock)

  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  const promptText = `matrix probe ${harness}`
  await input.click()
  await input.fill(promptText)
  await page.locator(SELECTORS.submitControl).last().click()

  await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

  const assistantId = mock.requests.promptBodies[0]?.assistantID
  if (!assistantId) throw new Error("primeHarness: no prompt dispatch recorded — cannot derive the assistant row id")

  // Wait for the primed turn to SETTLE (driveTurn stamps `time.completed` a tick
  // after the reply's final part — reply visibility above races it), capture the
  // settled assistant info row, then RE-OPEN it. Since the settled-message part
  // guard (opencode-conversation.ts's `settledAssistantMessage`, 69c6977757) a
  // completed assistant message rejects part events for part ids it does not
  // already have — so every test here (whether it drives parts through
  // `replay()` or emits them directly) needs the row deterministically open
  // before it delivers fixture parts. Waiting first makes the re-open
  // deterministic (no race against driveTurn's async settle); re-opening here,
  // once, covers direct-emit tests that never call `replay()`.
  let assistantInfo: Record<string, unknown> | undefined
  await expect.poll(async () => {
    const rows = await page.evaluate(async (id) => {
      const response = await fetch(`/session/${id}/message`)
      return response.json() as Promise<Array<{ info?: { id?: string; time?: { completed?: number } } }>>
    }, sessionId)
    const row = rows.find((item) => item.info?.id === assistantId)
    if (typeof row?.info?.time?.completed !== "number") return false
    assistantInfo = row.info as Record<string, unknown>
    return true
  }, { timeout: 15_000 }).toBe(true)

  const { completed: _completed, ...openTime } = (assistantInfo!.time ?? {}) as Record<string, unknown>
  bridgedEmit(
    {
      type: "message.updated",
      properties: { sessionID: assistantInfo!.sessionID, info: { ...assistantInfo!, time: openTime } },
    } as never,
    dir,
  )

  return {
    mock: { ...mock, emit: bridgedEmit as MockRuntimeHandles["emit"] },
    dir,
    sessionId,
    assistantId,
    assistantInfo: assistantInfo!,
  }
}

/**
 * Replays a fixture trace onto the primed assistant row. The row is already
 * SETTLED (`time.completed` — primeHarness waits for it), and settled assistant
 * messages reject part events for unknown part ids (the duplicate-reply race
 * fix in `opencode-conversation.ts`). So the replay brackets the trace with two
 * `message.updated` events: first re-open the row (same info, `time.completed`
 * stripped) so the fixture parts attach, then re-settle it with the original
 * persisted info — deterministic signals only, no wall-clock waits, and the
 * final state (settled turn carrying the fixture parts) matches what these
 * assertions always exercised.
 */
async function replay(
  mock: MockRuntimeHandles,
  dir: string,
  trace: Envelope[],
  assistantInfo: Record<string, unknown>,
) {
  const { completed: _completed, ...openTime } = (assistantInfo.time ?? {}) as Record<string, unknown>
  mock.emit(
    {
      type: "message.updated",
      properties: { sessionID: assistantInfo.sessionID, info: { ...assistantInfo, time: openTime } },
    } as never,
    dir,
  )
  for (const envelope of trace) mock.emit(envelope.payload as never, envelope.directory || dir)
  mock.emit(
    { type: "message.updated", properties: { sessionID: assistantInfo.sessionID, info: assistantInfo } } as never,
    dir,
  )
}

type SubagentHarnessCase = {
  name: string
  harness: string
  providerKind?: string
  providerId?: string
  transcript: MockRuntimeSubagentRow["transcript"]
  mode?: "foreground" | "background"
  openable: boolean
}

const subagentHarnessCases: SubagentHarnessCase[] = [
  { name: "OpenCode native", harness: "opencode", providerKind: "opencode", providerId: "ses-child-opencode", transcript: { kind: "live", ref: "ses-child-opencode" }, openable: true },
  { name: "Claude native", harness: "claude-sdk", providerKind: "claude-agent", providerId: "agent-42", transcript: { kind: "messages", ref: "agent-42" }, openable: true },
  { name: "Claude ACP", harness: "claude-acp", transcript: { kind: "messages", ref: "acp:agent-42" }, openable: true },
  { name: "Codex native", harness: "codex-app-server", providerKind: "codex", providerId: "thread-child-1", transcript: { kind: "live", ref: "thread-child-1" }, openable: true },
  { name: "Codex ACP", harness: "codex-acp", providerKind: "codex-acp-thread", providerId: "thread-child-1", transcript: { kind: "none" }, openable: false },
  { name: "Cursor native valid", harness: "cursor-sdk", providerKind: "cursor-agent", providerId: "cursor-agent-1", transcript: { kind: "file", ref: "cursor-transcript-1" }, openable: true },
  { name: "Cursor native invalid", harness: "cursor-sdk", providerKind: "cursor-agent", transcript: { kind: "none" }, openable: false },
  { name: "Cursor ACP", harness: "cursor-acp", transcript: { kind: "none" }, openable: false },
  { name: "Pi foreground", harness: "pi", providerKind: "pi", providerId: "pi-child-foreground", transcript: { kind: "live", ref: "pi-child-foreground" }, mode: "foreground", openable: true },
  { name: "Pi background", harness: "pi", providerKind: "pi", providerId: "pi-child-background", transcript: { kind: "live", ref: "pi-child-background" }, mode: "background", openable: true },
]

function subagentScenario(input: SubagentHarnessCase) {
  const suffix = input.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
  const subagentKey = `subagent-${suffix}`
  const toolCallId = `spawn-${suffix}`
  const childSessionId = input.openable ? `ses-child-${suffix}` : undefined
  const description = `Delegate ${input.name}`
  return {
    subagentKey,
    toolCallId,
    childSessionId,
    description,
    fixture: {
      rows: [{
        subagentKey,
        revision: 1,
        mode: input.mode ?? "foreground",
        status: "running",
        label: input.name,
        subagentType: "general-purpose",
        description,
        ...(input.providerKind ? { providerKind: input.providerKind } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        transcript: input.transcript,
        toolCallEdges: [{ toolCallId, role: "spawn", revision: 1 }],
      }] satisfies MockRuntimeSubagentRow[],
      ...(childSessionId ? {
        children: [{
          id: childSessionId,
          parentId: `ses_harness_matrix_${input.harness}`,
          title: input.name,
          prompt: description,
          reply: `child transcript for ${input.name}`,
        }],
      } : {}),
    },
  }
}

function subagentTaskEnvelope(input: {
  sessionId: string
  assistantId: string
  toolCallId: string
  description: string
}): Envelope {
  return {
    directory: "",
    payload: {
      id: `message.part.updated:${input.assistantId}:${input.toolCallId}`,
      type: "message.part.updated",
      properties: {
        sessionID: input.sessionId,
        part: {
          id: input.toolCallId,
          sessionID: input.sessionId,
          messageID: input.assistantId,
          type: "tool",
          callID: input.toolCallId,
          tool: "task",
          state: {
            status: "completed",
            input: { description: input.description, subagent_type: "general-purpose" },
            output: "",
            title: "task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        time: 2,
      },
    },
  }
}

function completeSubagent(
  mock: MockRuntimeHandles,
  directory: string,
  sessionId: string,
  subagentKey: string,
) {
  // `subagent-updated` is a contract-v4 RuntimeEventEnvelope. The real producers
  // (agent-sdk-runtime's subagent-admission `publish` → RuntimeEventHub) put it on
  // `/api/wr/runtime-events` ONLY, and the app consumes it only there
  // (global-sdk provider's runtime loop → applySubagentRuntimeEventEnvelope).
  // `emitRuntime` is the mock's canonical publisher for that family — `emitFlat`
  // would land the frame on the compat channels the real runtime never carries
  // it on, where nothing applies it.
  mock.emitRuntime({
    directory,
    sessionId,
    payload: {
      type: "subagent-updated",
      subagentKey,
      revision: 2,
      status: "completed",
    },
  })
}

const assistantContent = () => SELECTORS.assistantContentVisible

/**
 * Reasoning summaries are an opt-in feed setting
 * (`settings.general.showReasoningSummaries`, default `false` —
 * `src/platform/settings/provider.tsx`); `renderablePart`
 * (`message-timeline.data.ts`) drops every reasoning part while it is off. Flip it on
 * through the real settings UI — the setting is reactive, so already-streamed reasoning
 * parts appear as soon as the dialog closes.
 */
async function enableReasoningSummaries(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const toggle = dialog.locator('[data-action="settings-feed-reasoning-summaries"] [data-slot="switch-control"]')
  await toggle.scrollIntoViewIfNeeded()
  await toggle.click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

/**
 * SESSION-TIMELINE REDESIGN (2026-07-18) — three behaviors this file's
 * assertions now account for, verified against
 * the live DOM (`message-timeline.tsx`/`message-timeline.data.ts`):
 *  (a) TURN FOLD — an assistant turn with more than a couple of part groups collapses
 *      its middle groups behind a `[data-component="turn-fold"]` toggle ("Worked for …").
 *      Every tool group beyond the fold threshold is absent from the DOM until the fold
 *      is expanded (this is why a many-tool trace like opencode's renders only its
 *      leading/trailing text until unfolded). `revealTurn()` clicks it open.
 *  (b) WORK GROUPS — consecutive "work" tools (bash/command/shell/local_shell,
 *      edit/edit_file/write/write_file/apply_patch, webfetch, websearch/web_search)
 *      with ≥2 members fold into ONE closed-by-default `[data-component=
 *      "work-group-trigger"]` collapsible (summary e.g. "Edited 1 file · ran 1 command");
 *      a LONE work tool stays a standalone `[data-component="tool-part-wrapper"]` row
 *      whose subtitle is already visible. `revealTurn()` also opens every work- and
 *      context-group trigger so each member's own detail slot is reachable.
 *  (c) SHELL VOCABULARY — the harness-native shell tool names `shell` (Cursor SDK) and
 *      `command` (Codex app-server) are now normalized into the bash renderer
 *      (`shell-submessage-value` = the literal command, title shimmer "Ran"), NOT the
 *      generic MCP fallback they hit before this redesign — so behavior 4 asserts the
 *      command text, not a `basic-tool-tool-title` carrying the raw name.
 */
async function revealTurn(page: Page) {
  // The fold and the tool DOM race the trace replay in BOTH directions: the leading
  // text anchor renders before the turn folds (so a single up-front fold check can run
  // too early and skip a fold that mounts a beat later), and late part updates can
  // re-cross the fold threshold and re-collapse an already-opened fold, unmounting the
  // group triggers mid-expansion. A one-shot click sequence therefore flakes under CI
  // load. Converge instead: keep (re)opening the fold until the tool DOM is visible,
  // and keep (re)opening each group until its Collapsible reports expanded.
  const fold = page.locator('[data-component="turn-fold"] button').first()
  const toolDom = page.locator(
    '[data-component="tool-part-wrapper"], [data-component="work-group-trigger"], [data-component="context-tool-group-trigger"], [data-component="task-tool-card"]',
  ).first()
  const foldOpen = async () => {
    if ((await fold.count().catch(() => 0)) === 0) return
    if ((await fold.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null)) === "false") {
      await fold.click({ timeout: 2_000 }).catch(() => {})
    }
  }
  await expect
    .poll(
      async () => {
        await foldOpen()
        if (!(await toolDom.isVisible().catch(() => false))) return false
        // Stability re-check: the fold can MOUNT (closed) a beat after the
        // tools first render — returning on the first visible sample let the
        // fold collapse the tools right after this helper resolved (the exact
        // race the header documents). Hold the condition across a short gap,
        // re-opening a just-mounted fold before the final verdict.
        await page.waitForTimeout(350)
        await foldOpen()
        return toolDom.isVisible().catch(() => false)
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true)
  // Expand every work/context group so each grouped tool's own detail slot is reachable;
  // a lone work tool has no trigger (its subtitle is already visible).
  for (const sel of ['[data-component="work-group-trigger"]', '[data-component="context-tool-group-trigger"]']) {
    const triggers = page.locator(sel)
    for (let i = 0; i < (await triggers.count()); i++) {
      const trigger = triggers.nth(i)
      // `aria-expanded` lives on the Collapsible's BUTTON, which wraps this inner div —
      // read/assert it there, not on the div (the div never has the attribute). Read
      // state BEFORE clicking each round so a just-opened group is never re-clicked
      // closed, and re-open the fold first in case a re-render collapsed it and hid
      // this trigger.
      const expander = trigger.locator("xpath=ancestor-or-self::*[@aria-expanded][1]")
      const expanded = () => trigger.isVisible().catch(() => false).then(async (visible) =>
        visible ? (await expander.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null)) === "true" : false,
      )
      await expect
        .poll(
          async () => {
            if (await expanded()) return true
            await foldOpen()
            await trigger.click({ timeout: 2_000 }).catch(() => {})
            await page.waitForTimeout(250)
            return expanded()
          },
          { timeout: 20_000, intervals: [500, 1_000] },
        )
        .toBe(true)
        .catch(async () => {
          await expect(expander, `group trigger ${sel} #${i} never expanded`).toHaveAttribute("aria-expanded", "true")
        })
    }
  }
}

test.describe("core harness rendering matrix @core", () => {
  test("opencode native — dedicated ToolRegistry renderers for read/list/glob/webfetch/websearch/write/skill — behaviors 1,3", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: the injected extra text part renders verbatim (a leading part, shown
    // even while the rest of this many-tool turn is folded — also the delivery anchor
    // that proves the fixture trace reached the store before we unfold).
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })

    // SESSION-TIMELINE REDESIGN: this turn has enough part groups to fold; unfold it and
    // open every work/context group so each tool's detail slot is reachable (see
    // `revealTurn`).
    await revealTurn(page)

    // behavior 3: read/list/glob — consecutive "context" tools render grouped under ONE
    // closed-by-default `ContextToolGroup` collapsible (`[data-component=
    // "context-tool-group-trigger"]`/`[data-component="context-tool-group-list"]`),
    // opened above.
    await expect(content.locator('[data-component="context-tool-group-list"]').first()).toBeVisible({ timeout: 10_000 })

    // behavior 3: read.
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first()).toBeVisible({ timeout: 45_000 })
    // list: grouped context-tool items don't carry an individual `data-timeline-part-id`
    // (only the group's `Collapsible` wrapper carries a PLURAL, comma-joined
    // `data-timeline-part-ids`) — assert via that instead, now that the group is
    // expanded above.
    await expect(content.locator('[data-timeline-part-ids*="msg_assistant_1-list"]')).toBeVisible({ timeout: 45_000 })
    // glob (arg shows the literal pattern).
    await expect(content.locator('[data-slot="basic-tool-tool-arg"]', { hasText: "pattern=**/*.json" })).toBeVisible()
    // webfetch (literal url) — webfetch/websearch/write are consecutive "work" tools now
    // folded into ONE work group, opened by `revealTurn`.
    await expect(content.getByRole("link", { name: "https://example.com/docs" })).toBeVisible()
    // websearch (literal query).
    await expect(content.getByText("opencode config schema")).toBeVisible()
    // write (filename).
    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "config.json" })).toBeVisible()
    // skill (title = literal input.name, untranslated — rendered via
    // `[data-slot="basic-tool-tool-title"] class="capitalize agent-title"`, so the
    // rendered text is "Pdf" even though the underlying string is the verbatim lowercase
    // "pdf" — match case-insensitively, scoped to the tool title slot).
    await expect(content.locator('[data-slot="basic-tool-tool-title"]').filter({ hasText: /pdf/i })).toBeVisible()
  })

  test("opencode native — apply_patch dedicated renderer, GenericTool fallback, compaction divider — behaviors 3,4,7,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // Delivery anchor (leading text shown even while folded), then unfold + open groups.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // behavior 3/16: opencode's own native "apply_patch" tool reaches the dedicated
    // apply_patch renderer (single-file layout — filename visible). It is a LONE work
    // tool here (preceded by the `skill` part, followed by the `compaction` part) so it
    // stays a standalone tool row rather than folding into a work group.
    await expect(content.locator('[data-slot="apply-patch-filename"], [data-slot="message-part-title-filename"]', { hasText: "app.ts" }).first()).toBeVisible({ timeout: 45_000 })

    // behavior 4: a deliberately-unregistered tool name (`custom_mcp_tool`, in none of
    // the context/work/hidden vocabularies) still falls back to GenericTool — the raw
    // tool string appears verbatim in the title, and the subtitle is the first matching
    // literal input field.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "custom_mcp_tool" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "vector search" })).toBeVisible()
  })

  // behavior 7 (compaction divider). Root cause found via live store inspection (NOT the
  // session-turn.tsx collision the prior note guessed): the assistant `compaction` part
  // was dropped in the raw-Part<->UIMessage projection. `opencodePartToChatParts`
  // (opencode-conversation.ts) had no "compaction" case, so — exactly like the "agent"
  // and "file" gaps — the part never entered the TanStack UIMessage and thus never
  // reached `getMsgParts`/`renderablePart`/`PART_MAPPING["compaction"]`. Fixed by adding
  // the lossless compaction round-trip to the projection (both directions).
  test("opencode native — compaction divider renders on the assistant timeline — behavior 7", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // The assistant `compaction` part reaches its dedicated divider renderer
    // (PART_MAPPING["compaction"] -> MessageDivider) inline in the assistant timeline —
    // distinct from session-turn.tsx's separate user-message compaction TurnDivider.
    await expect(content.locator('[data-component="compaction-part"] [data-slot="compaction-part-divider"]')).toBeVisible({ timeout: 45_000 })
  })

  test("opencode native — question tool hidden while pending, visible once answered — behavior 10", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const trace = loadTrace("opencode", assistantId)
    await replay(mock, dir, trace, assistantInfo) // ends with the question part PENDING

    const content = page.locator(assistantContent())
    const questionText = "Which environment should I target?"

    // Delivery anchor, then fully unfold/expand the turn so the pending-question absence
    // below is proven by `renderable`'s pending-hide (message-timeline.data.ts) — NOT
    // merely by the turn fold hiding every tool.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // Pending: the whole tool-part-wrapper is absent, not merely visually hidden, even
    // with the turn revealed.
    await expect(content.getByText(questionText)).toHaveCount(0)
    await expect(content.locator('[data-component="question-answers"]')).toHaveCount(0)

    // Answer it — the fixture file's dedicated "questionAnswered" envelope.
    const fixture = loadFixtureFile("opencode", assistantId) as { questionAnswered: Envelope }
    mock.emit(fixture.questionAnswered.payload as never, fixture.questionAnswered.directory || dir)

    // The answered question mounts as a new standalone part in the (already unfolded)
    // turn; revealTurn again in case the added part re-crossed the fold threshold.
    await revealTurn(page)
    await expect(content.getByText(questionText)).toBeVisible({ timeout: 45_000 })
    await expect(content.locator('[data-component="question-answers"]')).toBeVisible()
    await expect(content.locator('[data-slot="answer-text"]', { hasText: "staging" })).toBeVisible()
  })

  test("opencode native — todowrite never renders a tool row — behavior 9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const content = page.locator(assistantContent())
    const before = await content.locator('[data-component="tool-part-wrapper"]').count()

    mock.emit(
      { type: "message.part.updated", properties: { sessionID: `ses_harness_matrix_opencode`, time: 999, part: { id: "msg_assistant_1-todo", sessionID: "ses_harness_matrix_opencode", messageID: assistantId, type: "tool", callID: "tool-todo-x", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "Ship it", status: "completed" }] }, output: "", title: "todowrite", metadata: {}, time: { start: 1, end: 2 } } } } } as never,
      dir,
    )
    mock.emit({ type: "todo.updated", properties: { sessionID: "ses_harness_matrix_opencode", todos: [{ id: "0", content: "Ship it", status: "completed" }] } } as never, dir)

    // Deterministic wait: poll the request log (todo route or SSE) plus the DOM count
    // stays put — not a bare sleep (INVARIANTS.md authoring rule #3).
    await expect(content.getByText("Ship it")).toHaveCount(0)
    await expect.poll(async () => content.locator('[data-component="tool-part-wrapper"]').count(), { timeout: 20_000 }).toBe(before)
  })

  test("opencode native — tool lifecycle pending -> running -> completed -> error — behavior 5", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const fixture = loadFixtureFile("opencode", assistantId) as { lifecycle: Record<"pending" | "running" | "completed" | "error", Envelope> }
    const content = page.locator(assistantContent())

    mock.emit(fixture.lifecycle.pending.payload as never, fixture.lifecycle.pending.directory || dir)
    const row = content.locator('[data-component="tool-part-wrapper"]').filter({ has: page.locator('[data-slot="basic-tool-tool-title"]') }).last()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(content.getByText("bun test")).toHaveCount(0) // pending: command hidden

    mock.emit(fixture.lifecycle.running.payload as never, fixture.lifecycle.running.directory || dir)
    await expect(content.getByText("bun test")).toHaveCount(0) // still running: still hidden

    mock.emit(fixture.lifecycle.completed.payload as never, fixture.lifecycle.completed.directory || dir)
    await expect(content.getByText("bun test")).toBeVisible({ timeout: 30_000 }) // completed: command visible

    mock.emit(fixture.lifecycle.error.payload as never, fixture.lifecycle.error.directory || dir)
    // error card replaces the tool body (`ToolErrorCard`,
    // packages/session-ui/src/components/tool-error-card.tsx) — closed by
    // default (`defaultOpen ?? false`), so its `state.error` detail text only
    // reaches the DOM/becomes visible once its own `Collapsible.Trigger` is
    // expanded.
    const errorTrigger = content.locator('[data-component="tool-trigger"]').filter({ has: page.locator('[data-component="tool-error-card-icon"]') }).last()
    await expect(errorTrigger).toBeVisible({ timeout: 30_000 })
    await errorTrigger.click()
    await expect(content.getByText("exit code 1")).toBeVisible({ timeout: 30_000 })
  })

  test("opencode native — session.diff routes to the diff cache, never a phantom message row — behavior 8", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const content = page.locator(assistantContent())
    const before = await content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count()

    const fixture = loadFixtureFile("opencode", assistantId) as { sessionDiff: Envelope }
    mock.emit(fixture.sessionDiff.payload as never, fixture.sessionDiff.directory || dir)

    await expect.poll(
      async () => content.locator('[data-component="tool-part-wrapper"], [data-component="text-part"], [data-component="reasoning-part"]').count(),
      { timeout: 20_000 },
    ).toBe(before)
    expect(nonBackgroundNoiseConsole(mock.requests.console.filter((line) => /error/i.test(line)))).toEqual([])
  })

  test("pi — shares the native rendering path (text renders) — behavior 1", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
  })

  // behavior 3 (pi's "one dedicated tool renderer" half): the regenerated pi
  // trace now carries a `read` tool envelope (fixture `main[3]`, produced by
  // `generate-harness-fixtures.ts`'s `opencodeNativeTrace("pi").slice(0, 4)` —
  // NOT hand-authored, satisfying DoD #4). It proves a Pi tool part reaches its
  // dedicated ToolRegistry `read` renderer, exactly like the other native
  // harnesses: even a single context-group tool renders inside the
  // closed-by-default `ContextToolGroup` collapsible, so `revealTurn` opens it.
  test("pi — one dedicated tool renderer (config.json subtitle) — behavior 3", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"pi")
    const trace = loadTrace("pi", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())
    // Delivery anchor: the leading text lands (shared native path) before we unfold.
    await expect(content.getByText("Reading the config, then editing it.")).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // The `read` tool reaches its dedicated renderer — subtitle = the read path.
    await expect(
      content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "config.json" }).first(),
    ).toBeVisible({ timeout: 45_000 })
  })

  test("claude-acp — text dedup, Terminal->bash, read, todowrite hidden, unbound Task omitted — behaviors 1,3,9,15,16", async ({ page }) => {
    // The longest trace in the matrix; on CI's 2-core runners the replay alone
    // crowds the 60s default and the run dies mid-revealTurn. slow() = 3x.
    test.slow()
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-acp")
    const trace = loadTrace("claude-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: delta ACCUMULATION — the fixture's two deltas ('Building the ' +
    // 'feature now.') concatenate to the final text once, with no re-appended prefix.
    // NOT snapshot dedup: the adapter already converted the raw cumulative snapshots
    // ("Building the " / "Building the feature now.",
    // generate-harness-fixtures.ts:155,160) into these incremental deltas upstream — see
    // the FIXTURE PRE-BAKING note in the SPEC block.
    // (Leading text part, shown even while the rest of the turn is folded — the
    // delivery anchor before we unfold.)
    await expect(content.getByText("Building the feature now.", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("Building the Building the", { exact: false })).toHaveCount(0)

    // SESSION-TIMELINE REDESIGN: unfold the turn and open its groups.
    await revealTurn(page)

    // behavior 16: the fixture's `part.tool: "bash"` (the ACP registry already mapped
    // Claude's raw "Terminal" title upstream — the raw string is NOT in the fixture, see
    // FIXTURE PRE-BAKING) dispatches to the bash renderer. A LONE work tool (between the
    // text and the read), so it stays a standalone row whose command subtitle is visible.
    // Converged, not asserted once — same rationale and pattern as the cursor-acp
    // test's lone-row poll below: a late re-render can re-collapse the fold AFTER
    // revealTurn returns, hiding this row until re-revealed.
    await expect
      .poll(
        async () => {
          const visible = await content.getByText("printf hi").isVisible().catch(() => false)
          if (visible) return true
          await revealTurn(page)
          return content.getByText("printf hi").isVisible().catch(() => false)
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    // behavior 3: the fixture's `part.tool: "read"` (raw "Read File" already normalized
    // upstream) hits the dedicated read renderer. Even a SINGLE context-group tool renders inside
    // the closed-by-default `ContextToolGroup` collapsible (opened by `revealTurn`).
    await expect(content.locator('[data-slot="basic-tool-tool-subtitle"]', { hasText: "index.ts" })).toBeVisible()

    // behavior 15: fixture translation alone carries no authoritative host spawn edge,
    // so it renders no subagent surface. The U13 matrix below supplies the durable host
    // association and proves the open path.
    await expect(content.getByText("Review the auth module")).toHaveCount(0)

    // behavior 9: "Update TODOs" never became a tool row.
    await expect(content.getByText("Ship the fix")).toHaveCount(0)
  })

  test("codex-acp — Permission fake tool routes to the dock (not a tool row); apply_patch resolves to edit; bash — behaviors 3,12,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-acp")
    const trace = loadTrace("codex-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // behavior 12: the permission dock renders, driven by permission.asked.
    await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 45_000 })
    const content = page.locator(assistantContent())

    // SESSION-TIMELINE REDESIGN: the apply_patch->edit and the bash are two consecutive
    // "work" tools, so they fold into ONE closed-by-default work group (summary "Edited 1
    // file · ran 1 command"); open it so each member's own row is reachable.
    await expect(content.locator('[data-component="work-group-trigger"]')).toBeVisible({ timeout: 45_000 })
    await revealTurn(page)

    // behavior 16 (finding, pinned as real): apply_patch resolves to the generic
    // "edit" renderer (filename visible), not a dedicated apply-patch-tool component.
    await expect(content.locator('[data-slot="message-part-title-filename"]', { hasText: "app.ts" })).toBeVisible()
    await expect(page.locator('[data-component="apply-patch-tool"]')).toHaveCount(0)

    // behavior 3: bash via kind-only classification.
    await expect(content.getByText("git status")).toBeVisible()

    // behavior 12 (exact proof, not vacuous): exactly the 2 REAL tool parts (the
    // apply_patch->edit and the bash, now the two members of the opened work group) ever
    // became tool-part-wrapper rows — the Permission tool_call never added a 3rd.
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(2)
  })

  test("cursor-acp — full-text snapshot dedup, WritableIterable sentinel swallowed, Terminal->bash, Task omitted, todowrite hidden — behaviors 9,13,14,15,16", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-acp")
    const trace = loadTrace("cursor-acp", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 13: the fixture's incremental deltas ('A' then '1' — the adapter's
    // post-dedup output for the raw "A"/"A1" snapshots at
    // generate-harness-fixtures.ts:317-318) accumulate to "A1" exactly once, no "AA1".
    // The dedup itself happened upstream; see the FIXTURE PRE-BAKING note.
    // (Leading text — the delivery anchor before we unfold.)
    await expect(content.getByText("A1", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("AA1")).toHaveCount(0)

    // behavior 14: the "Error: RetriableError: WritableIterable is closed" transport tail.
    // The DOM assertion alone is VACUOUS — `grep -c WritableIterable
    // e2e/fixtures/harness-traces/cursor-acp.json` is 0, so the string is not in the
    // replayed trace and `toHaveCount(0)` would pass on a blank page. The swallow happens
    // UPSTREAM (`isCursorWritableIterableTail`, agent-event-runtime
    // harnesses/acp/translate-session-update.ts:152,216-223), and the generator DOES feed
    // the raw chunk through the real adapter (generate-harness-fixtures.ts:324) — so the
    // discriminating proof available to a fixture replay is that the TRANSLATED trace
    // carries no trace of the sentinel. Fixtures are regenerated by script, so an adapter
    // regression that stopped swallowing it would fail HERE at the next regeneration.
    expect(JSON.stringify(trace), "the translated cursor-acp trace must not carry the swallowed transport tail").not.toContain(
      "WritableIterable",
    )
    // Corollary (kept, but not the proof): nothing renders it either.
    await expect(page.getByText("WritableIterable is closed")).toHaveCount(0)

    // SESSION-TIMELINE REDESIGN: unfold the turn and open its groups.
    await revealTurn(page)

    // behavior 16: the fixture's `part.tool: "bash"` (Cursor's raw "Terminal" title was
    // normalized upstream — see FIXTURE PRE-BAKING) hits the bash renderer. A LONE work
    // tool -> standalone row, command visible. Converged, not asserted once:
    // revealTurn's own header documents that late part updates can re-collapse the
    // fold AFTER the converge returns, and this lone-row assertion sits exactly in
    // that window — it flaked ~1/3 under load (CI shard 4, and locally under
    // --repeat-each). Re-converge until the row is visible, same pattern as the
    // helper itself.
    await expect
      .poll(
        async () => {
          const visible = await content.getByText("ls", { exact: true }).isVisible().catch(() => false)
          if (visible) return true
          await revealTurn(page)
          return content.getByText("ls", { exact: true }).isVisible().catch(() => false)
        },
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBe(true)

    // behavior 15: Cursor ACP exposes no authoritative host association, so it renders
    // no subagent surface instead of manufacturing a transcript identity from tool state.
    await expect(content.getByText("Investigate flaky test")).toHaveCount(0)

    // behavior 9: "Update TODOs" never became a tool row.
    await expect(content.getByText("Fix flake")).toHaveCount(0)
  })

  test("claude-sdk (native) — raw \"Grep\" falls back to GenericTool, TodoWrite hidden — behaviors 4,9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const content = page.locator(assistantContent())
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    // behavior 4: raw native "Grep" (capitalized) does not match the "grep"
    // ToolRegistry key -> GenericTool fallback, raw name verbatim in the title.
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "Grep" })).toBeVisible({ timeout: 45_000 })

    // behavior 9: TodoWrite intercepted before ever becoming a tool-start.
    await expect(content.getByText("Ship it", { exact: true })).toHaveCount(0)
  })

  // behaviors 2/17 (reasoning renders; diagnostics add zero extra rows). The reasoning
  // part is NOT undiagnosable as the prior remediation note assumed: live store
  // inspection proved the message.part.updated(text:"")+message.part.delta pair flows
  // correctly through the raw-Part<->UIMessage projection (opencode-conversation.ts maps
  // reasoning->thinking, accumulates the delta, and projects back to a reasoning Part
  // carrying the full text — verified via the projection log). The part reaches
  // `getMsgParts`, but `renderablePart(part, showReasoning)`
  // (message-timeline.data.ts) gates every reasoning part behind
  // `settings.general.showReasoningSummaries()`, which DEFAULTS TO FALSE
  // (src/platform/settings/provider.tsx) — reasoning summaries are opt-in. So the render
  // is correct; it only shows once the user enables the setting, which this test does
  // via the real settings UI before asserting.
  test("claude-sdk (native) — reasoning part renders, diagnostics add zero extra rows — behaviors 2,17", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"claude-sdk")
    const trace = loadTrace("claude-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    await enableReasoningSummaries(page)

    const content = page.locator(assistantContent())
    await revealTurn(page)

    // behavior 2: the reasoning part (message.part.updated text:"" + message.part.delta)
    // reaches its dedicated renderer once reasoning summaries are on. It mounts as a
    // collapsed "Thought" accordion — expanding it reveals the delta-accumulated text.
    const reasoning = content.locator('[data-component="reasoning-part"]')
    await expect(reasoning).toBeVisible({ timeout: 45_000 })
    // Expand until the detail is actually revealed: a single click can land
    // mid-mount while the delta text is still streaming and get swallowed by
    // a re-render, leaving the accordion collapsed for the whole wait
    // (run 369). Visible text short-circuits, so an open accordion is never
    // toggled shut.
    await expect(async () => {
      const detail = content.getByText("Let me check the grep results.")
      if (await detail.isVisible()) return
      await reasoning.locator('[data-component="tool-trigger"], [data-slot="basic-tool-tool-title"]').first().click()
      await expect(detail).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 45_000 })

    // behavior 17: the trailing runtime.diagnostic envelope (a claude_sdk.unmapped_event
    // diagnostic, not a Part) adds no timeline row of its own — the assistant turn's
    // rendered content is exactly the reasoning part, the text part, and the one Grep
    // tool row, with no phantom diagnostic/error row.
    await expect(content.getByText("Searching the repo.")).toBeVisible()
    await expect(content.locator('[data-component="reasoning-part"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-part-wrapper"]')).toHaveCount(1)
    await expect(content.locator('[data-component="tool-error-card"]')).toHaveCount(0)
  })

  test("codex-app-server (native) — proposed plan renders as plain text, \"command\" normalizes to the bash renderer — behaviors 4,11,17", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"codex-app-server")
    const trace = loadTrace("codex-app-server", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 11: the plan stream is ordinary paced text — no plan-specific
    // component/dock exists, so it shows up as literal markdown text.
    await expect(content.getByText("inspect tests")).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("run suite")).toBeVisible()

    // behavior 4 (SESSION-TIMELINE REDESIGN): the harness-native `command` tool name is
    // now normalized INTO the bash/shell renderer (the literal command shows in
    // `shell-submessage-value`; the title shimmer reads "Ran"), NOT the generic MCP
    // fallback it hit before this redesign — so no `basic-tool-tool-title` carries the
    // raw "command" string. A lone work tool, so it stays a standalone visible row.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "git status" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "command" })).toHaveCount(0)
  })

  test("cursor-sdk (native) — assistant snapshot dedup, \"shell\" normalizes to the bash renderer, updateTodos hidden — behaviors 1,4,9", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page,"cursor-sdk")
    const trace = loadTrace("cursor-sdk", assistantId)
    await replay(mock, dir, trace, assistantInfo)

    const content = page.locator(assistantContent())

    // behavior 1: the fixture's deltas 'Hel' + 'lo there' (the adapter's post-dedup
    // output for the raw "Hel"/"Hello there" snapshots, generate-harness-fixtures.ts:
    // 350-351) accumulate to "Hello there" once, no "HelHello" — see FIXTURE PRE-BAKING.
    await expect(content.getByText("Hello there", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(content.getByText("HelHello")).toHaveCount(0)

    // behavior 4 (SESSION-TIMELINE REDESIGN): the harness-native `shell` tool name is now
    // normalized INTO the bash/shell renderer (literal command in `shell-submessage-value`,
    // title shimmer "Ran"), NOT the generic MCP fallback it hit before — so no
    // `basic-tool-tool-title` carries the raw "shell" string. A lone work tool -> a
    // standalone visible row.
    await expect(content.locator('[data-slot="shell-submessage-value"]', { hasText: "bun test" })).toBeVisible()
    await expect(content.locator('[data-slot="basic-tool-tool-title"]', { hasText: "shell" })).toHaveCount(0)

    // behavior 9: updateTodos intercepted, never a tool row.
    await expect(content.getByText("Ship adapter")).toHaveCount(0)
  })

  // U13 closes the cross-harness subagent loop at the translated runtime/UI
  // boundary. Adapter-level suites prove how each provider discovers the row;
  // these scenarios deliberately start from the durable host row plus canonical
  // `subagent-updated` event that every adapter feeds to the app. The association
  // is the explicit spawn edge (`toolCallId`), never tool metadata, session titles,
  // provider ids, or transcript refs.
  for (const input of subagentHarnessCases) {
    test(`subagents — ${input.name} ${input.openable ? "opens its child transcript" : "is explicitly unavailable"} — behavior 15`, async ({ page }) => {
      test.slow()
      const scenario = subagentScenario(input)
      const primed = await primeHarness(page, input.harness, scenario.fixture)
      await replay(
        primed.mock,
        primed.dir,
        [subagentTaskEnvelope({
          sessionId: primed.sessionId,
          assistantId: primed.assistantId,
          toolCallId: scenario.toolCallId,
          description: scenario.description,
        })],
        primed.assistantInfo,
      )

      const card = page.locator(
        `[data-component="task-tool-card"][data-subagent-key="${scenario.subagentKey}"]`,
      )
      await expect(card).toBeVisible({ timeout: 45_000 })
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Working")
      if (input.mode === "background") {
        await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText(
          "Background · continues independently",
        )
      }

      completeSubagent(primed.mock, primed.dir, primed.sessionId, scenario.subagentKey)
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed", { timeout: 20_000 })

      const anchor = card.locator("xpath=ancestor::a[1]")
      if (!input.openable) {
        await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText("Transcript unavailable")
        await expect(anchor).toHaveCount(0)
        await expect(card.locator('[data-component="task-tool-action"]')).toHaveCount(0)
        return
      }

      await expect(anchor).toHaveCount(1)
      await expect(card.locator('[data-component="task-tool-action"]')).toHaveCount(1)
      const closeWorkspacePanel = page.getByRole("button", { name: "Close workspace panel", exact: true })
      if (await closeWorkspacePanel.isVisible().catch(() => false)) await closeWorkspacePanel.click()
      await anchor.click()
      await expect(page.getByText(`child transcript for ${input.name}`, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expectAssistantReplyVisible(page, `ack 1: matrix probe ${input.harness}`)
    })
  }

  test("subagents — narrow child surface is read-only and returns focus to its spawn card — behavior 15", async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 700, height: 900 })
    const input = subagentHarnessCases.find((item) => item.name === "OpenCode native")!
    const scenario = subagentScenario(input)
    const primed = await primeHarness(page, input.harness, scenario.fixture)
    await replay(
      primed.mock,
      primed.dir,
      [subagentTaskEnvelope({
        sessionId: primed.sessionId,
        assistantId: primed.assistantId,
        toolCallId: scenario.toolCallId,
        description: scenario.description,
      })],
      primed.assistantInfo,
    )

    const card = page.locator(
      `[data-component="task-tool-card"][data-subagent-key="${scenario.subagentKey}"]`,
    )
    const anchor = card.locator("xpath=ancestor::a[1]")
    await expect(anchor).toHaveCount(1)
    await anchor.focus()
    await page.keyboard.press("Enter")

    const childHeading = page.locator(`[data-session-timeline-session-id="${scenario.childSessionId}"] [data-subagent-child-heading]`)
    await expect(childHeading).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
    const backToParent = page.getByRole("button", { name: "Back to main session.", exact: true })
    await expect(backToParent).toBeVisible()
    await backToParent.click()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(anchor).toBeFocused()
    await expectAssistantReplyVisible(page, "ack 1: matrix probe opencode")
  })

  test("subagents — bare Pi capability emits no synthetic task card — behavior 15", async ({ page }) => {
    const { mock } = await primeHarness(page, "pi")
    await expect(page.locator('[data-component="task-tool-card"]')).toHaveCount(0)
    expect(mock.requests.badResponses).toEqual([])
  })

  test("subagents — unauthorized parent runtime stream is rejected before subscription — behavior 15", async ({ page }) => {
    await primeHarness(page, "opencode", {
      rows: [],
      runtimeEventAuthorizeParent: (parentSessionId) => parentSessionId !== "parent-denied",
    })
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/wr/runtime-events?parentSessionId=parent-denied")
      return { status: result.status, body: await result.json() }
    })
    expect(response).toEqual({ status: 403, body: { error: "Forbidden" } })
  })

  // behavior 6: assistant `file`-type parts (image/audio data-url, resource links) now
  // reach a dedicated renderer. Previously the REAL GAP was two-layered: no
  // `PART_MAPPING["file"]` component existed (message-part.tsx) AND the app's
  // `renderablePart` (message-timeline.data.ts) excluded "file" from its renderable set,
  // so a `file`-type assistant part was dropped from `groupParts()` and never hit the
  // DOM. Fixed by registering `FilePartDisplay` (image inline + preview, audio player,
  // resource-link row) and adding "file" to the renderable set.
  test("assistant file-type parts (image/audio/resource-link) render — behavior 6", async ({ page }) => {
    const { mock, dir, assistantId, assistantInfo } = await primeHarness(page, "opencode")
    const sessionID = "ses_harness_matrix_opencode"
    const filePart = (id: string, mime: string, url: string, filename: string, source?: unknown) =>
      mock.emit(
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 900,
            part: { id, sessionID, messageID: assistantId, type: "file", mime, url, filename, ...(source ? { source } : {}) },
          },
        } as never,
        dir,
      )

    // 1x1 transparent PNG (image → inline + preview-on-click)
    filePart(
      "msg_assistant_1-file-image",
      "image/png",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "shot.png",
    )
    // audio data-url (audio → <audio controls> player)
    filePart(
      "msg_assistant_1-file-audio",
      "audio/mpeg",
      "data:audio/mpeg;base64,SUQzAAAAAAAA",
      "clip.mp3",
    )
    // MCP resource link (neither image nor audio → link row)
    filePart(
      "msg_assistant_1-file-resource",
      "text/html",
      "https://example.com/report.html",
      "report.html",
      { type: "resource", clientName: "docs", uri: "https://example.com/report.html", text: { value: "", start: 0, end: 0 } },
    )

    const content = page.locator(assistantContent())

    // File parts are standalone (non-tool) groups — not foldable — so they render inline
    // without unfolding the turn.
    // Image: an inline <img> pointing at the data-url.
    const image = content.locator('[data-component="file-part"] img[data-slot="file-part-image"]')
    await expect(image).toBeVisible({ timeout: 45_000 })
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)

    // Audio: an <audio controls> element.
    await expect(content.locator('[data-component="file-part"] audio[data-slot="file-part-audio"]')).toHaveCount(1)

    // Resource link: an anchor row carrying the resource href + filename.
    const link = content.locator('[data-component="file-part"] a[data-slot="file-part-link"]')
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "https://example.com/report.html")
    await expect(link.locator('[data-slot="file-part-link-name"]')).toHaveText("report.html")
  })
})
