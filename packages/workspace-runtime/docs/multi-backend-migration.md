# Multi-Backend Migration: Claude SDK + Codex App-Server + OpenCode + Cursor ACP

## Goal

Replace the single ACPAdapter (which drives Claude, Codex, and Cursor via ACP protocol) with dedicated adapters:

| Agent | Current | Target |
|-------|---------|--------|
| Claude | ACP (`claude-agent-acp` binary) | `@anthropic-ai/claude-agent-sdk` in-process |
| Codex | ACP (`codex-acp` binary) | `codex app-server` (single long-lived process, JSON-RPC) |
| OpenCode | `OpenCodeAdapter` (HTTP+SSE) | Keep as-is |
| Cursor | ACP (`agent` binary) | Keep ACP — no SDK alternative |

## Required spikes (resolve before implementation)

1. **Claude SDK auth caching:** Does `@anthropic-ai/claude-agent-sdk` re-read `process.env.ANTHROPIC_API_KEY` on each `query()` call, or cache at init? Determines whether auth injection is possible for in-process usage.
   - **Paseo's approach:** Writes both OAuth tokens and API keys to `.credentials.json` in a per-workspace `CLAUDE_CONFIG_DIR`. See `paseo/packages/server/src/server/test-utils/claude-auth.ts`.
   - **Decision gate:** If spike reveals SDK re-reads env vars per-query → use `process.env.ANTHROPIC_API_KEY` mutation (simpler). If SDK caches at init → use `CLAUDE_CONFIG_DIR/.credentials.json` file writes (paseo pattern). Section 3 designs for the file-write approach as the conservative default.
2. **Codex app-server auth RPC:** Does the `initialize` RPC accept auth parameters, or is env-var-at-spawn the only mechanism?
   - **Decision gate:** If `initialize` supports auth params → use RPC update (no process restart needed). If env-only → auth rotation requires process restart + session recovery (section 5). Section 3 designs for env-only as the conservative default.
3. ~~**Codex JSON-RPC transport:**~~ **RESOLVED** — Both paseo and t3code confirm Codex app-server uses **stdio** (stdin/stdout), not TCP. No network exposure concern.

## Required dependency

**`@anthropic-ai/claude-agent-sdk`** must be added to `workspace-runtime/package.json` before Phase 2 begins. Verify: (a) package name and minimum version from paseo's `package.json`, (b) whether it's on public npm or requires private registry access, (c) peer dependencies it brings. The current dependencies include `@agentclientprotocol/sdk` and `@zed-industries/claude-agent-acp` (the binary) but not the SDK.

## Reference implementations

Both **paseo** and **t3code** have already implemented multi-backend adapter patterns for Claude SDK and Codex app-server. These are the primary references for this migration.

### Paseo (`test/paseo`)

| File | What it does |
|------|-------------|
| `packages/server/src/server/agent/agent-sdk-types.ts` (471 lines) | Unified `AgentClient` interface, `AgentStreamEvent` types, `AgentPermissionResponse` (`behavior: "allow" \| "deny"`) |
| `packages/server/src/server/agent/provider-manifest.ts` | 5 providers: claude, codex, copilot, opencode, pi — each with modes and capabilities |
| `packages/server/src/server/agent/provider-registry.ts` | Factory map: `PROVIDER_CLIENT_FACTORIES[provider]` → concrete client |
| `packages/server/src/server/agent/providers/claude-agent.ts` (3,847 lines) | Full Claude SDK adapter — query flow, `canUseTool` permission callback, `handlePermissionRequest`, resume via `resume: sessionId`, mode switching |
| `packages/server/src/server/agent/providers/codex-app-server-agent.ts` (3,730 lines) | Full Codex adapter — JSON-RPC over stdio, `item/commandExecution/requestApproval` handlers, thread resume, `MODE_PRESETS` (auto/full-access) |
| `packages/server/src/server/agent/providers/claude/tool-call-mapper.ts` | Claude tool names → canonical types (Bash→shell, Read→read, etc.) |
| `packages/server/src/server/agent/providers/codex/tool-call-mapper.ts` | Codex tool names → same canonical types |
| `packages/server/src/server/test-utils/claude-auth.ts` | `seedClaudeAuth()` — writes OAuth/API key to `CLAUDE_CONFIG_DIR/.credentials.json` |

### T3Code (`test/t3code`)

| File | What it does |
|------|-------------|
| `apps/server/src/provider/Services/ProviderAdapter.ts` | `ProviderAdapterShape<TError>` — generic interface with `startSession`, `sendTurn`, `respondToRequest`, `streamEvents` |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` (2,700 lines) | Claude adapter — `basePermissionMode` stored per session, `allowDangerouslySkipPermissions: true` for dynamic mode switching |
| `apps/server/src/provider/Layers/CodexAdapter.ts` (1,642 lines) | Codex adapter — wraps `CodexAppServerManager`, maps events to canonical `ProviderRuntimeEvent` |
| `apps/server/src/codexAppServerManager.ts` | JSON-RPC protocol handler — `respondToRequest()` sends decision (`"accept" \| "acceptForSession" \| "decline" \| "cancel"`) via JSON-RPC response ID |
| `apps/server/src/provider/Layers/ProviderService.ts` | Unified facade — routes to correct adapter by provider kind, event fan-out, session recovery |
| `apps/server/src/provider/Services/ProviderAdapterRegistry.ts` | Adapter lookup by `ProviderKind` |
| `packages/contracts/src/orchestration.ts` | `ProviderKind = ["codex", "claudeAgent"]`, `ProviderApprovalDecision = ["accept", "acceptForSession", "decline", "cancel"]`, `RuntimeMode` |

### Key patterns from both

1. **No shared sendMessage abstraction** — each adapter owns its full turn lifecycle (~2000-3800 lines each)
2. **Per-provider tool-call mappers** — separate files mapping native tool names to canonical types
3. **Opaque session handles** — paseo: `describePersistence()` returns provider-specific handle; t3code: `resumeCursor` is opaque `unknown` per adapter
4. **Claude auth via `CLAUDE_CONFIG_DIR`** — paseo writes credentials to a per-workspace config dir, avoiding host filesystem conflicts
5. **Claude `allowDangerouslySkipPermissions: true`** — both set this on query init to enable dynamic mode switching to `bypassPermissions` later
6. **Permission flow: Promise-based pending map** — both use `pendingPermissions: Map<id, { resolve, reject }>`, push event to UI, await resolution
7. **Codex approval decisions are strings** — t3code uses `"accept" | "acceptForSession" | "decline" | "cancel"`, paseo uses `"accept" | "decline" | "cancel"` (paseo lacks `acceptForSession`; t3code is authoritative for the full set)
8. **Codex JSON-RPC via stdio** — both wrap child process stdin/stdout, not TCP

## What breaks

### 1. RuntimeRunner type union — everywhere

**Current:** `"claude-acp" | "codex-acp" | "cursor-acp" | "opencode"`

**After:** `"claude" | "codex" | "cursor-acp" | "opencode"`

This string appears in:

| File | What references it |
|------|-------------------|
| `workspace-runtime/src/routes/config.ts:7` | `RuntimeRunner.type` definition |
| `workspace-runtime/src/routes/config.ts:22` | Config push validation — truthy check only, no enum validation |
| `workspace-runtime/src/adapters/index.ts:54` | `SessionRunner.type` definition |
| `workspace-runtime/src/server.ts:24-48` | `acp()` guard, `initialRunner()`, `createAdapter()` |
| `workspace-runtime/src/server.ts:117-138` | `apply()` snapshot handler — hot-swap adapter on type change |
| `workspace-runtime/src/server.ts:153-165` | Health endpoint — reports `agentType`, `acpBinary` |
| `workspace-runtime/src/server.ts:174-182` | `/api/wr/acp-config-options` — gates on `acp()` |
| `workspace-runtime/src/server.ts:186-204` | OpenCode proxy routes — gates on `runner.type !== "opencode"` |
| `workspace-runtime/src/store.ts:161,249,414-416` | `runner_type` persisted column |
| `claxedo-server/src/agent-config.ts:47` | `UserAgentConfig.runner.type` union |
| `claxedo-server/src/agent-config.ts:52-57` | `RuntimeConfigSnapshot` type |
| `claxedo-server/src/agent-config.ts:76` | `acpBinary()` — typed parameter accepts only `'claude-acp' \| 'codex-acp' \| 'cursor-acp'` |
| `claxedo-server/src/agent-config.ts:106-116` | `defaultRunner()` — calls `acpBinary(type)` for non-opencode types |
| `claxedo-server/src/local-agent-engine.ts:121-130` | **Second `createAdapter()`** — routes ALL non-opencode types to `ACPAdapter` unconditionally |
| `claxedo-server/src/local-agent-engine.ts` | 14+ additional `runner.type` references (lines 99, 122, 225, 249, 262, etc.) |
| `claxedo-server/src/session-runner.ts:19` | `session-runners.json` — persists runner type strings to disk |
| `claxedo-server/src/session-runner.ts:36-64` | `load()` — reads `session-runners.json`, no type normalization |
| `claxedo-server/src/routes/agent-config.ts:76` | `staticOptions()` — hardcodes `runner.type === 'claude-acp'` for model fallback |
| `claxedo-server/src/routes/agent-config.ts:163` | `validTypes` array — hardcoded `['claude-acp', 'codex-acp', 'cursor-acp', 'opencode']`, rejects unknown types with 400 |
| `claxedo-app/src/claxedo-ui/context/acp-config.ts:7` | `RunnerType` union in UI |
| `claxedo-app/src/claxedo-ui/context/acp-config.ts:10-18` | `ACP_DISPLAY_NAMES` map |
| `claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx` | Dropdown UI |
| `claxedo-app/src/overrides/components/prompt-input/submit.ts` | Submit behavior |
| `claxedo-app/e2e/.../10-agent-runner-selector.test.ts` | E2E tests — hardcoded strings |

**Complexity:** Medium. Mechanical rename but touches 25+ files across three packages (workspace-runtime, claxedo-server, claxedo-app). This is a clean cutover, not a dual-format migration.

**`acpBinary()` compile error:** `defaultRunner()` (`agent-config.ts:106`) calls `acpBinary(type)` for non-opencode types. `acpBinary()` only accepts `'claude-acp' | 'codex-acp' | 'cursor-acp'`. Passing `"claude"` or `"codex"` is a compile error. Fix: add a guard in `defaultRunner()` — `"claude"` and `"codex"` don't use ACP binaries, so return the runner without a `binary` field.

**`local-agent-engine.ts` second `createAdapter()`:** At line 121-130, ALL non-opencode types route to `ACPAdapter`. After migration, `"claude"` and `"codex"` would silently use the wrong adapter in local (non-sandbox) mode. Must add Claude/Codex adapter creation here, mirroring the `server.ts` changes.

**Persistence cutover — where `runner_type` actually lives:**

The RuntimeStore uses a journal-replay architecture: on startup, `reset()` deletes all DB rows then `replay()` re-applies events from `.jsonl` files. However, **the `Turn` type has no `runner` field** — `runner_type` is populated by `upsertSession()` from config operations, not journal replay. The `startTurn` control entry (`store.ts:698-732`) writes `userMessageId`, `assistantMessageId`, `agent`, `model`, `parts` — but not `runner_type`.

The actual persistence locations affected by the runner rename are:

| Location | How runner_type is stored |
|----------|--------------------------|
| `session-runners.json` (`session-runner.ts:19`) | JSON file on disk, read by `load()` at line 36-64 |
| `user-agent-config.json` (`agent-config.ts:90-97`) | JSON file on disk, deserialized on startup |
| `store.ts:1043` `updateSessionConfig()` | Writes runner_type to DB from config push |
| `store.ts:1005` `getSessionConfig()` | Reads runner_type from DB, casts to `SessionRunner['type']` |
| `store.ts:672-696` `bindSession()` | Sets runner_type on session creation |

**Fix:** Do a clean cutover instead of supporting mixed old/new reads in runtime code.

- `session-runners.json`: drop or rewrite entries using `claude-acp` / `codex-acp`
- `user-agent-config.json`: rewrite legacy runner values or reset them to a safe default before new code relies on them
- `store.ts` persisted `runner_type`: run a one-time data rewrite or clear incompatible session bindings during rollout
- Do **not** add `normalizeRunnerType()` to steady-state runtime code

**Config route validation:** `ConfigRoutes` (`config.ts:22`) currently does a truthy check only on `body.runner.type`. Add explicit enum validation against the allowed union. Without this, `createAdapter()` silently falls through to `OpenCodeAdapter` for unrecognized types.

**Deployment note:** claxedo-server and workspace-runtime do **not** need to accept both old and new type strings during rollout. Migrate or discard legacy persisted runner state as part of the cutover, then run only on the new type set.

---

### 2. `acp()` guard function — controls routing for half the server

**Current** (`server.ts:24-25`):
```ts
function acp(type: string) {
  return type === "claude-acp" || type === "codex-acp" || type === "cursor-acp" || type === "acp"
}
```

This gates:
- Adapter creation (line 38-46)
- Model hot-swap on config push (line 126-128)
- Auth injection via `setAuth()` (lines 130-136)
- Config options endpoint `/api/wr/acp-config-options` (line 175)
- Health endpoint fields `acpBinary` (line 164)

**Problem:** After migration, `"claude"` and `"codex"` are no longer ACP. The guard no longer makes sense as a binary classification.

**Fix approach:** Replace `acp()` with a `switch` on `runner.type`. There are exactly four backends, all known at compile time — capability-introspection interfaces (`supportsModelSwitch()`, `supportsAuth()`, etc.) are speculative generality for a closed set. Each `switch` case handles its known behavior directly:

```ts
// Replace acp() calls with explicit switch:
switch (runner.type) {
  case "cursor-acp":
    // ACP-specific: process management, setAuth, probe
    break
  case "claude":
    // In-process: no process management, OAuth/env auth, static config
    break
  case "codex":
    // Singleton process: restart-based auth, RPC probe
    break
  case "opencode":
    // HTTP proxy: no auth injection, no probe
    break
}
```

---

### 3. Auth injection pipeline — fundamentally different per backend

**Current flow:**
1. claxedo-server pushes `RuntimeSnapshot` via `POST /api/wr/config`
2. `apply()` in server.ts calls `adapter.setAuth({ anthropic, openai, cursor })` (line 131)
3. `setAcpAuth()` stores keys in module-level `_acpAuthKeys` (acp.ts:73-85)
4. Next ACP process spawn picks up keys as env vars (acp.ts:231-241)

**Endpoint security note:** The `POST /api/wr/config` endpoint receives auth keys in plaintext JSON with no caller authentication — it validates body shape but not caller identity. **Existing mitigation:** the server binds to `127.0.0.1` (`server.ts:269`), limiting network exposure to localhost. This is sufficient for the current sandbox architecture where claxedo-server and workspace-runtime are co-located. If the architecture changes to allow remote callers, add caller authentication (shared secret, mTLS). Tracked as a separate security hardening task outside this migration scope.

**What breaks per backend:**

- **Claude SDK:** Does not accept API keys in normal usage. It reads `~/.claude/.credentials.json` or macOS Keychain automatically. `setAuth({ anthropic: key })` becomes meaningless.
  - **Paseo's proven approach:** Write credentials to a per-workspace `CLAUDE_CONFIG_DIR/.credentials.json` file. Paseo's `seedClaudeAuth()` writes `{ oauthToken, apiKey }` to this file, and the SDK picks it up automatically. This solves both the auth injection problem and multi-tenant isolation.
  - **Implementation:** On `setAuth()`, write `{ apiKey: keys.anthropic }` (or `{ oauthToken }` for OAuth) to `$CLAUDE_CONFIG_DIR/.credentials.json`. Set `CLAUDE_CONFIG_DIR` per workspace at adapter init.
  - **Post-Spike 1 adjustment:** If spike reveals SDK re-reads `ANTHROPIC_API_KEY` per-query, use env-var mutation instead. The file-write approach remains valid as a fallback.
  - **API key mode:** The SDK respects `ANTHROPIC_API_KEY` env var, but the credentials file approach is more reliable for runtime updates.
  - **OAuth mode:** Users on Claude Pro/Max subscription would need `claude login` on the sandbox machine, or the OAuth token can be injected via `CLAUDE_CODE_OAUTH_TOKEN` env var → credentials file (paseo pattern).

- **Codex app-server:** Long-lived singleton inherits env at spawn time. API key changes require either:
  - (a) RPC-based auth update (if `initialize` RPC supports it — **spike required**)
  - (b) Process restart — but this kills all active Codex sessions. Must pair with session recovery (section 5): restart process, then `thread/read` for each active thread to rebind.

- **Cursor ACP:** Unchanged — keeps current `setAuth` flow.

**Credential file permissions (REQUIRED for multi-tenant):**

`.credentials.json` files contain API keys and OAuth tokens. In a multi-tenant sandbox, incorrect permissions = cross-tenant key theft.

- Write with mode `0o600` (owner read/write only)
- Ensure `CLAUDE_CONFIG_DIR` paths use workspace-specific subdirectories (use workspace ID which is already UUID-based)
- On adapter `dispose()`: delete `.credentials.json` files
- Verify directory permissions on adapter init: if `(stat.mode & 0o077) !== 0`, fix to `0o700`

**Credential memory lifecycle:**

The current `_acpAuthKeys` module-level object persists for the process lifetime with no clearing. This migration extends to more credential types.

- On `adapter.dispose()`: null out in-memory credential references
- On `setAuth()` rotation: overwrite (not append) the previous value
- On session end: no action needed (credentials are per-workspace, not per-session)

**Credential logging policy:**

Current code logs `hasAnthropic: !!_acpAuthKeys.anthropic` at info level. For multi-tenant:
- Log credential-adjacent operations at **debug** level only
- Never log credential values, even partially
- Never log which credential types are present (reveals tenant configuration)
- Ensure `.credentials.json` write operations do not log file contents

**Credential lifecycle requirements:**
| Backend | Receives auth | Staleness tolerance | Rotation mechanism |
|---------|---------------|--------------------|--------------------|
| Cursor ACP | env vars at spawn | Next spawn picks up new keys | Module-level store → env at spawn |
| Claude SDK (API key) | `CLAUDE_CONFIG_DIR/.credentials.json` | Immediate (SDK reads on query) | Overwrite credentials file |
| Claude SDK (OAuth) | `CLAUDE_CONFIG_DIR/.credentials.json` | Automatic (SDK handles refresh) | N/A — SDK manages internally |
| Codex app-server | env at spawn or RPC | Until process restart | Restart process or RPC update |

**Surface area:** `server.ts:130-136`, `acp.ts:73-85,229-241,633-640,1537-1553`, `routes/config.ts:22`, `claxedo-server/src/agent-config.ts`, `claxedo-server/src/routes/agent-config.ts`, claxedo-server config push endpoint.

---

### 4. Model/agent/variant switching — three different mechanisms

**Current ACP flow** (`acp-session.ts:146-186`, `sync()`):
1. Reads `PromptInput.agent` and `PromptInput.model`
2. Calls `conn.setSessionMode(agentSessionId, modeId)` for agent changes
3. Calls `conn.setSessionModel(agentSessionId, modelId)` for model changes
4. Calls `conn.setSessionConfigOption(agentSessionId, "variant", variant)` for thinking level

**Claude SDK replacement:**
- Model: `query.setModel(modelId)` — works mid-session
- Mode: `query.setPermissionMode(mode)` — maps to Claude's permission modes, NOT agent modes
- Thinking/effort: Requires query restart (`queryRestartNeeded = true` in Paseo's implementation)
- **No concept of "agent" switching** in Claude SDK. The "agent" in Claxedo's UI maps to Claude's permission modes (default, acceptEdits, plan, bypassPermissions)

**`bypassPermissions` enforcement (CRITICAL):**

The `bypassPermissions` mode disables all tool permission checks — arbitrary file writes, shell commands, and network access without user confirmation. In a multi-tenant sandbox, this is a tenant-escape vector if not properly gated.

How paseo/t3code handle this:
- **Paseo:** Exposes it as a mode with `"dangerous"` color tier and `ShieldOff` icon — visible but marked. Sets `allowDangerouslySkipPermissions: true` on query init to enable dynamic switching.
- **T3code:** Maps `RuntimeMode "full-access"` → Claude `bypassPermissions`. Stores `basePermissionMode` per session context for mode switching back after plan mode.

**Our enforcement design (implement in Phase 2):**

1. **Workspace policy storage:** Add `bypassPermissionsAllowed: boolean` to workspace configuration (stored in claxedo-server workspace settings, NOT in the unauthenticated `POST /api/wr/config` payload). Default: `false`.

2. **Server-side gate in `ClaudeSDKAdapter.setPermissionMode()`:**
   ```ts
   async setPermissionMode(mode: string): Promise<void> {
     if (mode === "bypassPermissions") {
       if (!this.workspacePolicy.bypassPermissionsAllowed) {
         log.warn("bypassPermissions rejected: workspace policy disallows", {
           workspaceId: this.workspaceId,
         })
         throw new Error("bypassPermissions not allowed for this workspace")
       }
     }
     // Log all mode transitions for audit
     log.info("permission_mode_transition", {
       workspaceId: this.workspaceId,
       from: this.currentMode,
       to: mode,
       timestamp: Date.now(),
     })
     this.currentMode = mode
     await this.query.setPermissionMode(mode)
   }
   ```

3. **SDK init requirement:** Must set `allowDangerouslySkipPermissions: true` on query init (required for later `setPermissionMode("bypassPermissions")` calls to work). This pre-disables SDK-level safety — the server-side gate in step 2 is the only defense.

4. **Open question:** When `bypassPermissions` is active, does the SDK's `canUseTool` callback still fire? If not, there is zero runtime permission checking during bypass mode. Verify during Phase 2 implementation. If callback does not fire, the mode-switch gate is the sole enforcement point — add extra logging and rate limiting.

5. **Audit log fields:** `{ workspaceId, sessionId, fromMode, toMode, timestamp, userId }` — stored to structured log, queryable for incident response.

**Codex app-server replacement:**
- Model: `params.model` on each `turn/create` — per-turn, not per-session
- Mode: `approvalPolicy` + `sandboxPolicy` on `turn/create`
- Thinking: `params.effort` on `turn/create`
- **No mid-session model switch** — model is set per-turn

**What breaks:**
- The `sync()` function in `acp-session.ts` is ACP-specific. Stateful adapters (Claude SDK, Codex, Cursor ACP) each need their own sync logic. Stateless adapters (OpenCode) send config directly in the message request — no separate sync phase needed.
- The `SessionConfig.agent` field maps to different concepts per provider:
  - Claude: permission mode (default/acceptEdits/plan/bypassPermissions)
  - Codex: approval policy preset (auto/full-access) + plan mode toggle
  - Cursor: ACP session mode

**Surface area:** `acp-session.ts:146-186`, `acp.ts:444-457,1025-1031`, `routes/config.ts`, `claxedo-app/.../acp-config.ts`, agent-runner-selector UI.

---

### 5. Session resume/recovery — completely different semantics

**Current ACP flow** (`acp.ts:998-1030`, `acp-session.ts:134-144`):
1. On process death: `processLostSession()` marks session as recoverable
2. On next `sendMessage`: detects missing ACP session
3. Calls `conn.loadSession(agentSessionId, { cwd })` or `conn.newSession()` to rebind
4. One retry on "Resource not found" before failing

**Claude SDK:**
- Resume = pass `resume: claudeSessionId` to `query()` options
- Session ID comes from the SDK's init message (`message.session_id`)
- Sessions persist in `$CLAUDE_CONFIG_DIR/projects/` on disk — SDK handles this
- **Process death is impossible** (in-process). But query stream can error. Recovery = create new query with `resume`.
- **New complexity:** Must store the Claude session ID in the store. The `agent_session_id` column currently holds ACP session IDs.
- **Filesystem isolation:** Already solved by `CLAUDE_CONFIG_DIR` per-workspace (see auth section).

**Paseo's resume pattern** (`claude-agent.ts:1901`): Stores `resumeCursor = { threadId, resume: sessionId, resumeSessionAt: lastAssistantUuid, turnCount }`. On resume, passes `resume: existingSessionId` to query options. T3code uses identical opaque `resumeCursor` approach.

**Codex app-server:**
- Resume = `thread/read` with `threadId`, then `turn/create` on existing thread
- Thread IDs persist in `~/.codex/sessions/` on disk
- Process death = app-server crashes. Must restart process, reload all active threads.
- **New complexity:** Thread ID is the resume handle. Must be stored in `agent_session_id`.
- **Filesystem isolation:** Same consideration — use `CODEX_CONFIG_DIR` per-workspace if needed.

**`agent_session_id` column semantics:**

The column's binding relationship (1:1 mapping per session) remains unchanged. But the content semantics change: after migration, this field stores provider-specific session handles:
- Cursor ACP: ACP session ID (UUID v4)
- Claude SDK: Claude session ID (format TBD — check SDK docs)
- Codex: Thread ID (format TBD — check Codex docs)
- OpenCode: HTTP proxy session ID

**Session ID format validation:** Add validation in each adapter's `resumeSession()` method (not in the store layer, which is provider-agnostic). Each adapter validates the format when it receives the session ID:

```ts
// In ClaudeSDKAdapter:
async resumeSession(sessionId: string): Promise<void> {
  if (!sessionId || typeof sessionId !== "string") {
    throw new SessionResumeMismatchError("claude", sessionId, "expected non-empty string")
  }
  // Claude-specific format check (TBD after SDK docs review)
  await this.query({ resume: sessionId, ... })
}
```

Fail loudly with clear error on mismatch to prevent silent cross-adapter bugs.

**What breaks:**
- `store.ts:672-696` `bindSession()` — binding logic stays same, ID format changes.
- `store.ts:758-778` `processLostSession()` — message says "ACP process restarted". Needs provider-aware messaging.
- `store.ts:734-756` `processLost(directory)` — for Claude SDK (in-process), process loss = Node died = everything dead. For Codex, only codex sessions affected. Must scope by runner type.
- `acp.ts:909-913` recovery error consumption — each adapter needs its own recovery pattern.

**Risk:** Session resume is the hardest part. The adapter must abstract over "give me back a working session from this ID" despite fundamentally different underlying mechanisms.

---

### 6. Permission handling — three async patterns

**Current ACP** (`acp.ts:316-355`):
- ACP binary calls `requestPermission()` on the Client interface
- Returns `Promise<RequestPermissionResponse>` — blocks the ACP binary until resolved
- `pendingPermissions` map stores resolver, UI pushes response via `respondPermission()`

**Claude SDK:**
- `canUseTool` callback on query options — called synchronously during message processing
- Returns `Promise<PermissionResult>` — blocks the SDK query pump
- Must be wired to same `pendingPermissions` → UI → resolve pattern
- **Different shape:** `PermissionResult` has `{ behavior: "allow", updatedInput, updatedPermissions }`, not ACP's `{ allow: boolean, always: boolean }`

**Codex app-server:**
- JSON-RPC request `item/commandExecution/requestApproval` (or `fileChange` or `fileRead`)
- Server must respond to the JSON-RPC request ID
- **Transport:** JSON-RPC over stdin/stdout (confirmed by both paseo and t3code). No network exposure — process isolation provides the trust boundary.
- **Different shape:** Response is `{ approved: true, sandboxPolicy?: ... }`, not ACP permission options

**Deny-by-default invariant (REQUIRED):**

Permission response translation must be deny-by-default. If the adapter cannot map a permission decision to the backend's native format (unknown decision value, missing field, type mismatch), it MUST deny. This prevents silent permission escalation from mistranslation.

**Concrete enforcement — `mapPermissionDecision()` function:**

```ts
type PermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"
type BackendType = "claude" | "codex" | "cursor-acp"

function mapPermissionDecision(
  decision: PermissionDecision,
  backend: BackendType,
): ClaudePermissionResult | CodexDecision | AcpPermissionResponse {
  switch (decision) {
    case "allow_once":
      switch (backend) {
        case "claude": return { behavior: "allow", updatedInput: undefined }
        case "codex": return { decision: "accept" }
        case "cursor-acp": return currentAcpMapping("allow_once")
        default: assertNever(backend)
      }
    case "allow_always":
      switch (backend) {
        case "claude": return { behavior: "allow", updatedPermissions: [/*...*/] }
        case "codex": return { decision: "acceptForSession" }
        case "cursor-acp": return currentAcpMapping("allow_always")
        default: assertNever(backend)
      }
    case "deny":
      switch (backend) {
        case "claude": return { behavior: "deny", message: "User denied" }
        case "codex": return { decision: "decline" }
        case "cursor-acp": return currentAcpMapping("deny")
        default: assertNever(backend)
      }
    case "reject_always":
      switch (backend) {
        case "claude": return { behavior: "deny", message: "User rejected", interrupt: true }
        case "codex": return { decision: "cancel" }
        case "cursor-acp": return currentAcpMapping("reject_always")
        default: assertNever(backend)
      }
    default:
      // DENY-BY-DEFAULT: unknown decision → deny
      log.error("Unknown permission decision, denying", { decision, backend })
      switch (backend) {
        case "claude": return { behavior: "deny", message: "Unknown decision" }
        case "codex": return { decision: "decline" }
        case "cursor-acp": return currentAcpMapping("deny")
        default: assertNever(backend)
      }
  }
}
```

**Required test matrix for deny-by-default:**
- Unknown/malformed decision value → maps to deny
- Missing fields in PermissionResult → maps to deny
- Type mismatches (number where string expected) → maps to deny
- Timeout on pending permission → resolves to deny, not hang
- All 4 decision × 3 backend combinations produce valid output
- These tests are mandatory gate for Phase 2 and Phase 3 completion, not Phase 4

**Permission response translation (summary):**

| Our decision | Claude SDK (`PermissionResult`) | Codex app-server (JSON-RPC response) | Cursor ACP |
|---|---|---|---|
| `allow_once` | `{ behavior: "allow", updatedInput }` | `{ decision: "accept" }` | Current ACP response |
| `allow_always` | `{ behavior: "allow", updatedPermissions: [...] }` | `{ decision: "acceptForSession" }` | Current ACP response |
| `deny` | `{ behavior: "deny", message }` | `{ decision: "decline" }` | Current ACP response |
| `reject_always` | `{ behavior: "deny", message, interrupt: true }` | `{ decision: "cancel" }` | Current ACP response |

**Note on Codex `acceptForSession`:** T3code includes this decision; paseo does not. Use the t3code set as authoritative since it maps cleanly to our `allow_always` semantics.

**Claude SDK permission flow (from paseo `claude-agent.ts:2725`):**
1. SDK calls `canUseTool(toolName, input, options)` callback
2. Adapter creates `AgentPermissionRequest`, pushes `permission_requested` event
3. Stores `{ resolve, reject, cleanup }` in `pendingPermissions` map
4. Returns `Promise<PermissionResult>` — blocks SDK until UI responds
5. On abort signal: deletes from map, rejects promise
6. On response: maps via `mapPermissionDecision()` to native format

**Codex permission flow (from t3code `codexAppServerManager.ts:817`):**
1. App-server sends JSON-RPC request: `item/commandExecution/requestApproval` (or `fileChange`, `fileRead`)
2. Adapter stores `{ jsonRpcId, turnId, itemId, requestId }` in `pendingApprovals` map
3. Pushes approval request event to subscribers
4. On response: maps via `mapPermissionDecision()`, sends JSON-RPC response with stored `jsonRpcId`

**Permission event shape — ACP field compatibility:**

The `pending_permission` table has NOT NULL columns: `patterns_json`, `always_json`, `metadata_json`. Claude and Codex permissions don't natively have these fields. Each adapter must construct compatible values:

| Field | Claude SDK | Codex | Cursor ACP |
|-------|-----------|-------|------------|
| `patterns_json` | Extract from `canUseTool(toolName, input)` — e.g., file paths from input | Extract from `requestApproval` item — command, file paths | Native ACP patterns |
| `always_json` | Empty array `[]` (Claude uses `updatedPermissions` instead) | Empty array `[]` | Native ACP always rules |
| `metadata_json` | `{ toolName, inputSummary }` | `{ itemType, command, jsonRpcId }` | Native ACP metadata |

Alternatively, relax the NOT NULL constraint on these columns during Phase 1 if the adapter-constructed values prove to be noise rather than signal.

**Surface area:** `acp.ts:316-355,1460-1523`, `store.ts:211-224,575-586`, `routes/session-core.ts` permission endpoints, `compat-events.ts:361-366`, frontend `PermissionDock` (`packages/app/src/pages/session/composer/session-permission-dock.tsx`).

---

### 7. Tool call translation — the largest surface

**Existing abstraction:** The codebase defines `AgentBackendPlugin<Native, State>` (adapters/index.ts:32-34), extending `AgentAdapter` with `translateNativeEvent(event: Native, state: State): AgentEvent[]`. New adapters may implement this interface but are not required to — the current `ACPAdapter` implements `AgentAdapter` directly, not `AgentBackendPlugin`. Both paseo and t3code also do not share a translation interface between their adapters. Use `AgentBackendPlugin` if it fits naturally; otherwise implement `AgentAdapter` directly and use `translateNativeEvent` as an internal pattern.

**Current:** Single `translateSessionUpdate()` in `translate-session-update.ts` maps ACP `SessionUpdate` → `AgentEvent[]`.

ACP normalizes tool calls from all providers into:
```
tool_call:        { id, title, kind, status, input, output, ... }
tool_call_update: { id, title, kind, status, input, output, ... }
```

**Claude SDK tool calls come as:**
```
SDKMessage with type "assistant":
  content: [{ type: "tool_use", id, name, input }, { type: "tool_result", ... }]
```
- No `title` — only `name`
- No `kind` — must infer from tool name (Read→read, Edit→edit, Bash→shell, etc.)
- Input/output are structured objects, not the flattened ACP shape
- Tool lifecycle: `tool_use` block appears first, then `tool_result` in next message

**Codex app-server tool calls come as JSON-RPC notifications:**
```
item.started:   { type: "command_execution" | "file_change" | "mcp_tool_call", ... }
item.updated:   { ...updated fields... }
item.completed: { ...final state... }
```
- Separate notification per lifecycle phase
- `command_execution` has `command`, `aggregated_output`, `exit_code`
- `file_change` has `changes: [{ path, kind }]`
- No unified `tool_call` shape — each item type has its own structure

**What breaks:**
- `translate-session-update.ts` tool_call / tool_call_update handlers (lines 311-430) are ACP-specific
- `acp-registry.ts` maps `(client, title, kind, name)` to intent — only the Cursor entries stay
- `acp-state.ts` `reduceTool()` / `viewTool()` (lines 489-534) — state machine designed for ACP's update pattern
- Tool metadata enrichment (files, paths, commands) in `acp-state.ts:315-463` — extraction logic tied to ACP `rawInput` shape

**What to build:**
- `translate-claude-sdk.ts`: Implements `translateNativeEvent` for `SDKMessage`. Must handle:
  - `tool_use` → `tool-start` + `tool-input`
  - `tool_result` → `tool-output` or `tool-error`
  - Text content → `text-delta`
  - Thinking/reasoning → `thinking-delta`
  - Sub-agent spawning → `subagent-spawned`

- `translate-codex-appserver.ts`: Implements `translateNativeEvent` for JSON-RPC notifications. Must handle:
  - `item.started` (command_execution) → `tool-start` with shell metadata
  - `item.updated` (command_execution) → streaming `tool-output` deltas
  - `item.completed` (file_change) → `file-diff` events
  - `item.agent_message.delta` → `text-delta`
  - `turn.completed` → `finish` + `usage`

**Tool-name → kind mapping:** Each translator should own its own tool-name-to-kind mapping inline (simple lookup table, ~10 entries). Extract to a shared `tool-kind-registry.ts` in Phase 4 only if actual duplication warrants it — consistent with the "extract after two adapters" principle in section 9.

**Input validation:** Both translators parse data from external processes and produce events rendered in the UI. Add basic zod schema validation for incoming event shapes before processing. Default to safe no-op for unrecognized event types. Note: the existing ACP translator (`translate-session-update.ts`) does not perform input validation or XSS sanitization — adding it to new translators only creates an inconsistency. Track XSS sanitization as a cross-cutting security improvement for all translators after the migration.

**Risk:** This is the highest-effort piece. Each translator will be ~250 lines. Test translators as pure functions in isolation — no adapter/process spinup needed.

---

### 8. Config options / model discovery — completely different APIs

**Current** (`acp.ts:1555-1607`):
- `peekConfigOptions()`: Returns cached `SessionConfigOption[]` from last ACP session
- `probeConfigOptions()`: Spawns a separate "probe" ACP process, initializes it, creates throwaway session to get config options, then extracts model/agent/variant lists
- Config options are ACP-native: `{ id, name, category, type: "select"|"boolean", currentValue, selectOptions }`
- Probe timeout: 10s default (`CLAXEDO_ACP_PROBE_TIMEOUT_MS`)

**Claude SDK:**
- Models: Hardcoded list — Opus 4.6, Sonnet 4.6, Haiku 4.5 (see `claude-models.ts` in Paseo)
- Modes: `default`, `acceptEdits`, `plan`, `bypassPermissions` — static
- Thinking options: `low`, `medium`, `high` — static
- **No probe process needed.** Zero latency.

**Codex app-server:**
- Models: `model/list` JSON-RPC to the running app-server process
- Modes: Static — `auto`, `full-access`
- Thinking: From model's `supportedReasoningEfforts`
- **Must have a running process to probe.** Fallback if not running: return cached list or empty.

**Adapter-side synthesis:** Each adapter's `probeConfigOptions()` should return data in the existing `AcpConfigOption` shape (`{ id, name, category, type, currentValue, selectOptions }`). The adapters do the translation from native formats — the frontend stays unchanged. This keeps the migration scoped to the adapter layer.

**What breaks:**
- `/api/wr/acp-config-options` endpoint (server.ts:174-182) — currently gates on `acp()`. Replace with adapter capability switch.
- `claxedo-server/src/routes/agent-config.ts:76` — `staticOptions()` hardcodes `runner.type === 'claude-acp'` for model fallback list. Must update to `runner.type === 'claude'` (or both during transition).
- Model ID format differs: Claude uses `claude-opus-4-6`, Codex uses `gpt-5.4`, OpenCode uses `anthropic/claude-sonnet-4-6`. The `PromptModel { providerID, modelID }` shape in `PromptInput` handles this — each adapter maps to its native format.

---

### 9. `sendMessage` flow — the core async generator

**Current ACP** (`acp.ts:861-1236`):
1. Guard duplicate activity (865-870)
2. Lookup/create session in store (880-909)
3. Spawn/reuse ACP process (893-900)
4. Yield initial events (910-947)
5. Resume session if fresh process (1013-1023)
6. Sync config (model/agent/variant) (1025-1031)
7. Register update listener → translate → queue compat events (1039-1092)
8. Register permission pusher (1093-1115)
9. Run `proc.prompt()` (1140-1163) — serial, one at a time
10. Yield queued events until idle/error (1168-1191)
11. Auto-title generation (1173-1177)

**Each new adapter must replicate this flow** but with different:
- Step 3: Claude SDK = create `Query` (no spawn). Codex = ensure app-server running.
- Step 5: Claude SDK = `resume` option. Codex = `thread/read`.
- Step 6: Claude SDK = `query.setModel()`. Codex = params on `turn/create`.
- Step 7: Different native events, different translators (via `translateNativeEvent`).
- Step 8: Different permission callback wiring.
- Step 9: Claude SDK = push to input stream. Codex = `turn/create` RPC.

**Approach: shared utilities, not forced abstraction.** Both paseo (3,847 + 3,730 lines) and t3code (2,700 + 1,642 lines) implement per-adapter turn flows with zero shared abstraction. Each adapter owns its full lifecycle. Extract only truly shared logic as standalone helpers:

```ts
// Shared helpers any adapter can use:
export function* yieldQueuedEvents(queue: AgentEvent[]): AsyncIterable<CompatEvent> { ... }
export async function generateSessionTitle(
  text: string,
  titleFn: (text: string) => Promise<string>
): Promise<string> { ... }
export function createEventQueue(): AgentEvent[] { ... }
```

Extract these helpers **after** two adapters are implemented and actual duplication points are visible — not before. This is Phase 4 work.

---

### 10. Process lifecycle — three models

| | ACP (current) | Claude SDK | Codex app-server |
|---|---|---|---|
| Process count | 1 per session | 0 (in-process) | 1 singleton |
| Boot cost | 5-10s | 0 | ~3s (once) |
| Death handling | `processLost()` marks sessions | N/A (query error → retry) | Restart process, reload threads |
| Idle timeout | Kill after 5min | Close query? | Keep running |
| Memory | Per-process overhead | Query state in heap | Per-process overhead (shared) |
| Dispose | Kill child process | Close query stream | Kill child process |

**What breaks:**
- `ACPAdapter.dispose()` kills one process. `ClaudeSDKAdapter.dispose()` closes all queries. `CodexAppServerAdapter.dispose()` kills the singleton.
- Health endpoint (server.ts:153-171) reports `acpBinary`, `processCount`, `activeProcessCount` — conditionally report based on runner type. Don't report `processCount` for Claude SDK.
- `processLost()` in store is called from ACP process death callback — Claude SDK has no process to lose. Codex singleton death affects all sessions — must recover all active threads.

**Codex singleton recovery design:**

The Codex app-server is a singleton process shared across all sessions. Process death affects every active Codex session. Current `processLost(directory)` (store.ts:734-756) selects ALL sessions in a directory, not just Codex sessions.

Recovery protocol:
1. Codex process death detected (exit event on child process)
2. Adapter enumerates active threads from its `Map<sessionId, threadId>` (maintained in-memory)
3. Adapter calls `processLost()` with a **runner-type-scoped query** (add `WHERE runner_type = 'codex'` to the existing query)
4. Restart the Codex process
5. For each active thread: attempt `thread/read` to verify thread is recoverable
6. Mark threads that fail `thread/read` as unrecoverable — emit synthetic error event to UI
7. On next `sendMessage` for each recovered thread: `turn/create` on existing thread

**Codex dispose semantics:** On adapter dispose, cancel in-flight turns, wait for threads to idle (5s timeout), then kill the process. Log active thread count at dispose time.

---

### 11. Auto-title generation — currently ACP-dependent

**Current** (`acp.ts:1238-1351`):
1. Emit truncated text as immediate title (1246-1270)
2. Fire-and-forget: spawn temp ACP session → send "title this" prompt → extract title (1278-1351)
3. Poll for completion (1590-1601)

**Fix:** Extract title generation into a shared utility (`generateSessionTitle()`) that accepts a model callback. Each adapter provides its own lightweight model call:
- Claude SDK: Direct `@anthropic-ai/sdk` call with Haiku
- Codex app-server: Existing `turn/create` with nano model
- Cursor ACP: Keep current temp-session approach

Title generation must include error handling:
```ts
async function generateSessionTitle(
  text: string,
  titleFn: (text: string) => Promise<string>,
): Promise<string> {
  try {
    const title = await titleFn(text)
    if (!title || typeof title !== "string") throw new Error("empty title")
    return title
  } catch (err) {
    log.debug("Title generation failed, using truncated text", {
      error: err instanceof Error ? err.message : String(err),
    })
    return text.slice(0, 100) // Fallback to truncated
  }
}
```

---

### 12. Abort/interrupt — different cancellation semantics

**Current ACP** (`acp.ts:1353-1371`):
```ts
async abort(id, directory) {
  const proc = this.sessions.get(id)?.proc
  if (proc?.alive) {
    await proc.conn.cancel({ sessionId: agentSessionId })
  }
}
```

**Claude SDK:** `query.abort()` or close the input stream. Query yields final `result` with `stop_reason: "interrupted"`.

**Codex app-server:** Send `turn/cancel` or `thread/cancel` JSON-RPC request.

Minor — `abort()` is simple per adapter. UI must handle different "interrupted" response shapes.

---

### 13. Slash commands — different discovery

**Current** (`acp.ts:1417-1456`):
- `listCommands()` uses probe process + agent extraction from config options
- `executeCommand()` sends command as prompt text with `/` prefix

**Claude SDK:** Has `query.listCommands()` API. Commands include /help, /compact, /clear, etc.
**Codex app-server:** May support commands — needs investigation.

Minor — command discovery is adapter-specific. Each adapter implements `listCommands()` and `executeCommand()` differently. The UI just renders a list of `{ name, description }`.

---

### 14. Test surface

Files that need updating:

| Test file | Why |
|-----------|-----|
| `acp.ts` unit tests | Runner type strings, mock shapes |
| `acp-session.ts` tests | ACP-specific session state |
| `translate-session-update.test.ts` | ACP update shapes |
| `translate-chunk-to-event.test.ts` | AgentEvent→CompatEvent (should mostly survive if AgentEvent stays same) |
| `acp-probe-options.test.ts` | Probe pattern changes |
| `acp-list-agents.test.ts` | Agent extraction changes |
| `store.test.ts` | `runner_type` fixtures, cutover rewrite/reset behavior for persisted runner state |
| `routes/session.test.ts` | Mocked adapter — needs new runner types |
| `routes/config.test.ts` | RuntimeRunner type validation, enum enforcement |
| `claxedo-server/src/routes/agent-config.test.ts` | `staticOptions()` runner type check, `validTypes` array |
| `claxedo-app/.../acp-config.test.ts` | RunnerType union |
| `claxedo-app/.../agent-runner-selector.vitest.tsx` | UI component |
| `claxedo-app/.../submit.test.ts` | Prompt submission |
| `claxedo-app/.../bootstrap.test.ts` | Global sync with runner types |
| `claxedo-app/e2e/.../10-agent-runner-selector.test.ts` | Hardcoded `"claude-acp"`, `"codex-acp"` strings throughout |

**New test files:**
| Test file | What to cover |
|-----------|---------------|
| `translate-claude-sdk.test.ts` | All SDKMessage → AgentEvent mappings (pure function tests, no adapter spinup) |
| `translate-codex-appserver.test.ts` | All JSON-RPC notification → AgentEvent mappings |
| `permission-mapping.test.ts` | All 4 decision × 3 backend combinations; deny-by-default for unknown decisions, missing fields, type mismatches, timeouts |
| `runner-cutover.test.ts` | one-time rewrite/reset of persisted `claude-acp` / `codex-acp` runner values |

---

## Execution order

### Phase 0: Spikes (1-2 days)
Resolve the two remaining spikes. Document results as decision gate outcomes (see spike section). If spike outcomes differ from assumptions in sections 3-5, update affected sections before Phase 2 begins.

### Phase 1: Type system + routing (2-3 days)
1. **Add runner types** — extend union to include `"claude" | "codex"` across all three packages (workspace-runtime, claxedo-server, claxedo-app). Replace legacy type usage directly rather than supporting mixed reads. Add enum validation to `ConfigRoutes` and `validTypes` array. Update `ACP_DISPLAY_NAMES` and frontend `RunnerType` union atomically.
2. **Fix `acpBinary()` and `defaultRunner()`** — guard against `"claude"` and `"codex"` types (no binary needed).
3. **Update both `createAdapter()` functions** — `server.ts` AND `local-agent-engine.ts:121-130`. Add new runner types to the switch immediately. Stub with `throw new Error("not implemented")` until adapters exist.
4. **Replace `acp()` guard** with explicit switch statements in all 5 locations in server.ts.
5. **Relax `pending_permission` table constraints** if needed — evaluate whether `patterns_json`/`always_json`/`metadata_json` NOT NULL constraints should be relaxed for non-ACP adapters.
6. **Add `@anthropic-ai/claude-agent-sdk` dependency** to workspace-runtime package.json.

### Phase 2: Claude SDK adapter (3-5 days)
7. **`ClaudeSDKAdapter`** — full adapter with `sendMessage`, `abort`, `probeConfigOptions`, `listCommands` methods. Includes:
   - `CLAUDE_CONFIG_DIR` per-workspace setup with `0o600` credential file permissions
   - `canUseTool` callback → `pendingPermissions` → UI wiring
   - `bypassPermissions` enforcement: workspace policy check, audit logging
   - `setPermissionMode()` gate with deny-by-default
   - Session resume via `resume: sessionId`
   - Credential cleanup on `dispose()`
8. **`translate-claude-sdk.ts`** — pure-function translator with zod schema validation for incoming events.
9. **`mapPermissionDecision()`** — shared permission mapping function with exhaustive switch and deny-by-default. Full test matrix (4 decisions × 3 backends × edge cases).

### Phase 3: Codex app-server adapter (3-5 days)
10. **`CodexAppServerAdapter`** — full adapter. Includes:
    - Singleton process management with graceful shutdown
    - JSON-RPC over stdio plumbing
    - Thread-based session resume (`thread/read` + `turn/create`)
    - Process death recovery (runner-type-scoped `processLost()`, thread enumeration)
    - Credential handling (env-at-spawn or RPC, per spike 2 outcome)
11. **`translate-codex-appserver.ts`** — pure-function translator with zod schema validation.

### Phase 4: Cleanup + integration (2-3 days)
12. **Strip Claude/Codex from `ACPAdapter`** — leave only Cursor.
13. **Extract shared helpers** — `yieldQueuedEvents()`, `generateSessionTitle()`, `createEventQueue()`, `tool-kind-registry.ts` — based on actual duplication observed in phases 2-3. Only extract if duplication warrants it.
14. **Update tests** — all files listed in section 14.

### Phase 4.5: Security checkpoint
Before enabling new adapters in any environment:
- [ ] `bypassPermissions` mode is gated by workspace policy
- [ ] Permission translation deny-by-default tests pass for all decision × backend combinations
- [ ] `.credentials.json` file permissions are `0o600`
- [ ] Credential cleanup on adapter `dispose()` is implemented
- [ ] Credential logging is debug-level only, no values logged

### Phase 5: Rollout (1-2 days)
15. **Feature-flag rollout** — deploy behind `CLAXEDO_ADAPTERS` env var (comma-separated list of enabled adapter types). Default to `cursor-acp,opencode` until enabled. Parsed at server startup in `createAdapter()` — if user requests a disabled adapter, return error with clear message.
16. **Staged enablement** — enable Claude SDK first in staging, monitor error rates. Then Codex. Then promote to production.

**Parallelization:** Phases 2 and 3 can be done in parallel by two engineers. Phase 1 must complete first. Phase 4 depends on both 2 and 3.

**Estimated effort:** 12-18 days with two engineers working in parallel. The reference implementations (2,700-3,847 lines per adapter) and the 10-step sendMessage flow each adapter must replicate suggest 3-5 days per adapter is more realistic than 2-3.

---

## Rollback plan

1. Disable new adapters: set `CLAXEDO_ADAPTERS=cursor-acp,opencode`
2. New sessions route to ACP/OpenCode-only paths according to the remaining enabled adapters.
3. Migrated Claude/Codex session bindings may be discarded as part of rollback; no preservation guarantee is required.
4. If rolling back to pre-migration code, clear `session-runners.json`, legacy runner config, and persisted `runner_type` rows that contain `"claude"` or `"codex"` before starting the old build.

## Future capabilities (out of scope)

These are enabled by the new adapters but not part of this migration:
- **Fork/revert:** Claude SDK supports `query.rewindToMessage()`, Codex supports `thread/rollback`. Currently no-op — can remain so.
- **MCP server integration:** New adapters have their own MCP patterns — investigate separately.
- **Config endpoint caller authentication:** If sandbox architecture changes to allow remote callers to `POST /api/wr/config`, add shared secret or mTLS. Currently mitigated by localhost binding.
- **Cross-cutting XSS sanitization:** Apply input sanitization to all translators (including existing ACP), not just new ones.
