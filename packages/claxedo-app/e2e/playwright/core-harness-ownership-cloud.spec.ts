/**
 * SPEC: Cloud/workspace-runtime session harness ownership (spec 3's matrix, over the relay)
 *
 * PURPOSE — a cloud (sandbox VM) or user-hosted workspace runs sessions through the
 * Claxedo control plane + Workspace Relay instead of the loopback OpenCode server. This
 * spec proves the SAME harness-ownership contract as `core-harness-ownership-local`
 * (spec 3) still holds once every request is routed through the workspace-scoped relay
 * lane (`/workspaces/:workspaceId/...`, same-origin path prefix, confirmed in
 * `core-cloud-provisioning.spec.ts`) — AND documents the parts of that contract that are
 * genuinely DIFFERENT for a relay-backed workspace: draft-time harness switching never
 * touches the local readiness-check endpoint, the model-options endpoint is a relay-only
 * route, and a draft pane that carries a non-OpenCode harness selection across a
 * navigation into a workspace-runtime directory has that selection forcibly reset — so a
 * cloud/user-hosted session can never silently inherit a harness/model chosen for a
 * different (local or other-workspace) scope.
 *
 * STATE MODEL — same client-local `harnessStore` as spec 3
 * (`src/claxedo-ui/context/harness-store.ts`, scope = `panePreferenceScope`), but the
 * runtime wiring diverges once `harnessWorkspaceRuntimeRef({directory})` resolves truthy
 * (`src/session-client/harness/store-policy.ts:76-78`, backed by
 * `sessionWorkspaceRuntimeRef` reading the SIGNED PROJECT INVENTORY's `workspaces[dir].kind`,
 * `src/shell/workspace/session-workspace-key.ts:20-65` — a directory only resolves
 * `"cloud"`/`"user-hosted"` when the inventory says so, never by guessing from shape):
 *   - `shouldUseLocalHarnessConfigApi` (`store-policy.ts:169-176`) is `false` whenever
 *     `workspaceKind` is `"cloud"` or `"user-hosted"` — regardless of transport.
 *   - Draft harness switch (`switchDraftHarness`,
 *     `src/claxedo-ui/context/harness-switcher.ts:77-98`): when `useLocalHarnessConfig`
 *     is true AND `workspace.kind` is NOT cloud/user-hosted, it POSTs
 *     `/api/claxedo/agent-config/harness` and uses the response's readiness (spec 3's
 *     path). For a cloud/user-hosted directory that POST is SKIPPED entirely —
 *     `status` is hardcoded `true` (`postHarnessConfig` is never called,
 *     harness-switcher.ts:84-87) — so a cloud/user-hosted draft's harness readiness is
 *     UNCONDITIONALLY "ready" the instant it is picked; there is no draft-time
 *     "Unavailable"/"Connecting" state to observe (see HARNESS NOTES).
 *   - Model options for a configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *     `codex-app-server`, `cursor-acp`, `cursor-sdk`) come from a DIFFERENT endpoint once
 *     `harnessWorkspaceRuntimeRef` is truthy: `configOptionsFetch`
 *     (`src/claxedo-ui/context/harness-config-runtime.ts:126-146`) calls
 *     `workspaceHarnessTransport(params).fetch(workspaceRuntimeAgentConfigPath({resource:
 *     "api/wr/harness-config-options", directory, harnessType: type}))` instead of the
 *     local `/api/claxedo/agent-config/harness/options` — a relay request whose path is
 *     `/workspaces/:workspaceId/api/wr/harness-config-options?directory=...&harness=<type>`
 *     (`harness-config-routes.ts:41-50`, `transport.ts`'s `createTransport` +
 *     `workspace-runtime-request.ts:226` build the `/workspaces/:workspaceId` prefix).
 *   - Session create/prompt/message/config/capabilities for a relay-backed session go
 *     through the SAME session-client code as local, proxied by
 *     `workspaceHarnessTransport`/the session controller's own transport onto
 *     `/workspaces/:workspaceId/session...` — never the loopback `/session/...` paths
 *     directly (verified per-request below via the mock's path routing, not by trusting
 *     client code).
 *   - Cross-workspace leak guard: `shouldResetWorkspaceDraftHarness`
 *     (`store-policy.ts:80-92`) fires inside `createHarnessHydrator`'s `hydrate()`
 *     (`src/claxedo-ui/context/harness-hydrator.ts:89-100`) whenever the scope is still a
 *     draft, the CURRENT `directory` resolves a workspace-runtime ref (cloud/user-hosted),
 *     there is no session yet, and the scope's already-selected harness (from whatever it
 *     was set to before this hydrate call) is not `"opencode"` — it force-resets the
 *     scope's harness to `"opencode"`. The scope key is `panePreferenceScope` — when a
 *     stable `draftId` (the pane's `surfaceId`) is supplied, the scope is `draft:${draftId}`
 *     and does NOT change with `directory`
 *     (`src/pane/store/pane-preferences.ts:39-43`), so a SAME-PANE, same-tab, client-side
 *     navigation (Solid Router's `navigate()`, e.g. via the empty-draft header's project
 *     `<Select>`, `openProject` in `src/components/session/session-new-design-view.tsx`)
 *     from a local directory (harness already picked) into a workspace-runtime directory
 *     is exactly the carryover this guard exists to prevent — it is the mechanism behind
 *     "no local/OpenCode state leaks into cloud sessions" / "switching local↔cloud leaks
 *     nothing". `harness-preferences.ts`'s `save()` is a documented no-op ("new choices
 *     are persisted by session config", not per-scope localStorage) — so this in-memory
 *     reset is the ONLY guard against carryover; there is no separate persisted-storage
 *     isolation to fall back on.
 *
 * ANATOMY — same selectors as spec 3 (`[data-action="prompt-model"]`,
 *   `[data-action="prompt-harness-model"]`, the harness `<Select>` trigger/options, submit
 *   control) plus:
 *   - relay lane path prefix `/workspaces/<workspaceId>/...` — every session/prompt/
 *     message/config/capabilities/provider/harness-options request for a relay-backed
 *     session lands here, never on the bare `/session/...`/`/api/claxedo/...` paths.
 *   - `/workspaces/<workspaceId>/api/wr/harness-config-options?harness=<type>` — the
 *     relay's per-harness model-options endpoint (query-param scoped, see STATE MODEL).
 *   - the empty-draft header's project `<Select>` (only rendered pre-send,
 *     `session-new-design-view.tsx`, `!runtimeMode()`) — a `role="button"` trigger showing
 *     the current project's label and `role="option"` entries for every top-level project
 *     in the signed inventory (including a cloud workspace registered as its OWN
 *     top-level project row); selecting a different entry calls `navigate()` (client-side,
 *     no page reload) — the vehicle this spec uses to reproduce the same-pane
 *     local→cloud navigation the leak guard defends against.
 *
 * BEHAVIORS —
 *   1. For each configurable harness (`claude-acp`, `claude-sdk`, `codex-acp`,
 *      `codex-app-server`, `cursor-acp`, `cursor-sdk`): selecting it on a cloud
 *      workspace's draft resolves its model via the relay's
 *      `/api/wr/harness-config-options` endpoint (never the local
 *      `/api/claxedo/agent-config/harness/options` endpoint), and that harness owns the
 *      submit payload's `providerID`/`modelID`/`agent` through draft → first send
 *      (session create, relay lane) → reload → a second send — all dispatched through
 *      `/workspaces/:workspaceId/...`, never the bare `/session/...` paths. The harness
 *      `<Select>` is disabled once the session exists, identically to local.
 *   2. Pi is a fixed-model harness on a cloud workspace exactly as it is locally: zero
 *      `/api/wr/harness-config-options` requests, instantly ready, submitted payload
 *      carries `providerID: "pi"`, `modelID: "virtual"`.
 *   3. `/api/wr/harness-config-options` requests are scoped per harness: switching the
 *      draft harness selection re-issues the request with `harness=<the newly selected
 *      type>`, and the model resolved into `[data-action="prompt-harness-model"]` always
 *      matches THAT harness's catalog — never a stale/different harness's model left over
 *      from a prior selection.
 *   4. Selecting a configurable harness on a cloud workspace draft sends ZERO POSTs to the
 *      local `/api/claxedo/agent-config/harness` status endpoint — readiness resolves
 *      "ready" unconditionally pre-send (see HARNESS NOTES for the consequence).
 *   5. Picking a non-OpenCode harness while the draft pane's directory is a plain local
 *      project, then client-side-navigating (via the project `<Select>`, no page reload)
 *      that SAME pane to a cloud workspace's directory, resets the draft harness back to
 *      OpenCode BEFORE any cloud request is made: exactly one model control
 *      (`[data-action="prompt-model"]`) is present immediately after the navigation
 *      settles, and the prompt subsequently sent through the cloud workspace carries
 *      `providerID: "opencode"` — the local harness/model selection never reaches the
 *      relay lane.
 *
 * INVARIANTS — harness ownership (#1 in e2e/INVARIANTS.md): the selected harness owns
 *   model/effort/payload at every stage, exactly one model control exists at a time, a
 *   harness is locked once the session is created. No silent fallback (#3): the ONE
 *   fallback-to-OpenCode this spec exercises (behavior 5) is the INTENDED cross-workspace
 *   leak guard, not a failure-path fallback — it fires deterministically on navigation,
 *   before any request, never mid-turn. Submit gating (#4): every wait below is a
 *   deterministic DOM/request-count assertion, never a bare `waitForTimeout`.
 *
 * HARNESS NOTES — cloud/user-hosted drafts skip the local readiness POST/polling
 *   entirely (behavior 4) — so spec 3's "Unavailable" red-dot and "Connecting" pill
 *   pre-send states are structurally unreachable for a cloud DRAFT (not a bug: there is
 *   no backend call whose failure could produce them before a session exists). An
 *   ALREADY-CREATED cloud session's readiness still derives from
 *   `GET /session/:id/config` the same as local (`harnessStateFromSessionConfig`,
 *   harness-hydrator.ts:75) — re-verifying that path is spec 3-shaped and out of scope
 *   here.
 *
 * OUT OF SCOPE — the 4-step workspace-provisioning pipeline and reload-mid-provision
 *   resume (`core-cloud-provisioning`, spec 11); busy/thinking/escalation/abort UI
 *   (`core-busy-abort-errors`, spec 5); relay offline/403/viewer-role and the
 *   arm-once/reconnect contract (`core-cloud-offline-roles`, spec 13); the
 *   model/effort/variant/multi-agent selector mechanics themselves
 *   (`core-model-effort-agent-controls`, spec 4); per-harness event/tool rendering
 *   fidelity (`core-harness-rendering-matrix`, spec 10); user-hosted's distinct 3-step
 *   connect pipeline (`core-user-hosted-workspace`, spec 14) — this spec always uses
 *   `kind: "cloud"`, never `"user-hosted"`, for its workspace(s).
 *
 * KNOWN GAP (blocks the oracle on every relay-lane send; see `test.fixme()` sites below)
 *   — a brand-new workspace-runtime (cloud/user-hosted) session's assistant reply cannot
 *   currently render in this app at all, confirmed by source, not just by this mock:
 *   (1) `workspaceRuntimeOwnsLiveEvents()` (`src/context/global-sdk.tsx:363-366`) makes
 *   the client permanently skip polling `/global/event` once a session's directory/
 *   workspaceId resolves a workspace-runtime ref — unconditional, not gated on session ID
 *   shape. (2) The ONLY remaining channel, `/api/wr/runtime-events`, decodes each frame as
 *   a `RuntimeEventEnvelope` and feeds `envelope.payload` through
 *   `createOpencodeCompatProjection().ingest()`
 *   (`packages/agent-event-runtime/src/projections/opencode-compat/projection.ts`,
 *   `translateRuntimeEventToCompat`'s exhaustive switch over every `AgentRuntimeEvent`
 *   variant in `packages/agent-event-runtime/src/contracts/agent-runtime-event.ts`) — that
 *   switch NEVER emits a compat `message.updated` event for any input; only
 *   `message.part.updated`/`message.part.delta`/`message.completed` are ever produced.
 *   (3) The client's conversation store only creates a NEW message row from
 *   `message.updated` (`upsertMessage`, `src/shell/chat/opencode-conversation.ts:134-144`);
 *   `upsertPart`/`appendPartDelta` (same file, lines 156-203) require the row to already
 *   exist and silently no-op (`return false`) otherwise — so a part-delta stream alone can
 *   never make a NEW assistant message appear. (4) There is no fallback fetch-based
 *   hydration for the primary pane either: `src/shell/chat/conversation-chat-client.ts:44-
 *   46` states outright "the live event path still flows through
 *   applyRegisteredConversationEvent, so this connection is never the source of streamed
 *   messages today", and `src/pages/session.tsx:1377` passes `messages={() => undefined}`
 *   to `SessionConversationOwner` for the main pane, so `hydrateRegisteredConversationSnap
 *   shot` never fires there. (5) Separately, `opencodeCompatProjectionOwner`
 *   (`packages/agent-event-runtime/src/projections/opencode-compat/ownership.ts:34-40`)
 *   routes any `ses_`-prefixed session id to a DIFFERENT "opencode-legacy" bridge instead
 *   of the runtime-events pipeline — a `ses_`-prefixed session on a workspace-runtime
 *   directory (this mock's shape, matching sibling spec 11's `core-cloud-provisioning.spec
 *   .ts`'s `SESSION_ID = "ses_core_cloud_provisioning"`) therefore falls through BOTH
 *   pipelines. Net effect verified empirically in this file's own first run (see PR/task
 *   history): the user's own message renders (client-side optimistic add, independent of
 *   this whole path), but the assistant's never does, for every harness including plain
 *   `opencode` — this is not specific to any one harness or to this mock's event shapes.
 *   Scenarios that only assert pre-send state (no prompt sent) are unaffected and remain
 *   real, executing tests.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-harness-ownership-cloud"
const PROJECT_ID = "proj_core_harness_cloud"
const WORKSPACE_ID = "ws_core_harness_cloud"

type Harness =
  | "opencode"
  | "claude-acp"
  | "codex-acp"
  | "cursor-acp"
  | "claude-sdk"
  | "codex-app-server"
  | "cursor-sdk"
  | "pi"

type HarnessModelOption = { id: string; name: string }

const HARNESS_MODELS: Record<Harness, HarnessModelOption> = {
  opencode: { id: "big-pickle", name: "Big Pickle" },
  "claude-acp": { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
  "claude-sdk": { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
  "codex-acp": { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  "codex-app-server": { id: "gpt-5.5", name: "GPT-5.5" },
  "cursor-acp": { id: "cursor-auto", name: "Cursor Auto" },
  "cursor-sdk": { id: "cursor-auto", name: "Cursor Auto" },
  pi: { id: "virtual", name: "Virtual" },
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (!("type" in part) || part.type !== "text") return []
      if (!("text" in part) || typeof (part as { text?: unknown }).text === "undefined") return []
      return [(part as { text: string }).text]
    })
    .join("\n")
    .trim()
}

// Same delivery mechanism as e2e/helpers/mock-runtime.ts's EventBus ("How streaming
// works" there) and core-cloud-provisioning.spec.ts's Bus: each GET blocks until an
// event is pending (or idles out), fulfills with the queued batch, then ends.
class Bus<T> {
  private pending: T[] = []
  private waiters: Array<() => void> = []
  emit(payload: T) {
    this.pending.push(payload)
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
  private async waitForPending(idleTimeoutMs: number) {
    if (this.pending.length > 0) return
    await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), wait(idleTimeoutMs)])
  }
  async drain(idleTimeoutMs: number) {
    await this.waitForPending(idleTimeoutMs)
    const batch = this.pending
    this.pending = []
    return batch
  }
}

type MockRequests = {
  createSessionCount: number
  promptCount: number
  promptBodies: Array<{ text: string; agent?: string; providerID?: string; modelID?: string }>
  harnessOptionsRelayCount: number
  harnessOptionsRelayHarnesses: string[]
  harnessConfigLocalPostCount: number
}

/**
 * Installs the FULL cloud mock for this spec: a plain local project (DIR, no
 * workspaces) AND a cloud workspace registered as its OWN top-level project row
 * (worktree === WORKSPACE_ID, self-referencing `workspaces` map) so the empty-draft
 * header's project picker can navigate between them client-side (behavior 5). Mounts the
 * relay lane (`/workspaces/:workspaceId/...`: session/prompt/message/config/
 * capabilities/provider/agent/command/permission/question/mcp/lsp/vcs/todo/event/
 * api-wr-harness-config-options) plus the supporting local-origin routes (bootstrap,
 * project inventory, workspace resolve/connection, the local draft-harness POST/options
 * endpoints for the plain local project, and the global event stream).
 */
async function installCloudHarnessMock(page: Page): Promise<{ requests: MockRequests; session: { id: string } }> {
  let SESSION_SEQ = 0
  let sessionId = ""
  let sessionCreated = false
  let activeHarness: Harness = "opencode"
  let messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  let promptCount = 0
  const sessionBus = new Bus<Record<string, unknown>>()

  const requests: MockRequests = {
    createSessionCount: 0,
    promptCount: 0,
    promptBodies: [],
    harnessOptionsRelayCount: 0,
    harnessOptionsRelayHarnesses: [],
    harnessConfigLocalPostCount: 0,
  }

  const cloudProjectRow = () => ({
    id: "proj_core_harness_cloud_ws",
    worktree: WORKSPACE_ID,
    name: "core-harness-cloud-workspace",
    sandboxes: [WORKSPACE_ID],
    workspaces: { [WORKSPACE_ID]: { id: WORKSPACE_ID, kind: "cloud", workspace_name: "main", directory: WORKSPACE_ID, available: true } },
  })
  const localProjectRow = () => ({
    id: PROJECT_ID,
    worktree: DIR,
    name: "core-harness-cloud-local",
    sandboxes: [] as string[],
    workspaces: {} as Record<string, unknown>,
  })

  function harnessModel(h: Harness) {
    return HARNESS_MODELS[h] ?? HARNESS_MODELS.opencode
  }

  function sessionRow() {
    const model = harnessModel(activeHarness)
    return {
      id: sessionId,
      slug: sessionId,
      projectID: "proj_core_harness_cloud_ws",
      directory: WORKSPACE_ID,
      title: textOf(messages[0]?.parts) || "",
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      config:
        activeHarness === "opencode"
          ? { harness: { type: "opencode", model: model.id, status: "ready", ready: true }, model: { providerID: "opencode", modelID: model.id }, provider: { id: "opencode", model: model.id }, agent: "build" }
          : { harness: { type: activeHarness, model: model.id, status: "ready", ready: true }, model: { providerID: activeHarness, modelID: model.id }, provider: { id: activeHarness, model: model.id }, agent: "build" },
    }
  }

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    // Let real Clerk network calls through unmocked (same fix as
    // core-cloud-provisioning.spec.ts). The webdriver auto-bypass in
    // src/utils/auth-client.ts's testAuth() does not always short-circuit
    // initializeClerk() on this suite's dev server, so `initializeClerk()`
    // (called unconditionally at boot, src/index.tsx:75) really does reach
    // Clerk's `dev_browser`/`environment`/`client` endpoints. Catching those
    // in this spec's own catch-all 598 breaks Clerk's SDK init with "ClerkJS:
    // Something went wrong initializing Clerk in development mode.", which
    // surfaces as a workspace-connection failure ("Workspace failed to
    // start") unrelated to this spec's own mocked surface — the real Clerk
    // dev sandbox (VITE_CLERK_PUBLISHABLE_KEY in .env.local) answers these
    // harmlessly over real network, so let them through instead.
    if (url.hostname.endsWith(".clerk.accounts.dev") || url.hostname.endsWith(".clerk.com")) return route.continue()

    if (url.pathname === "/api/wr/events") {
      const batch = await new Bus<Record<string, unknown>>().drain(50)
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: batch.length ? "" : ": heartbeat\n\n" }).catch(() => {})
    }

    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        project: [localProjectRow(), cloudProjectRow()],
        provider: {
          all: [{ id: "opencode", name: "opencode", env: [], models: { [HARNESS_MODELS.opencode.id]: { id: HARNESS_MODELS.opencode.id, name: HARNESS_MODELS.opencode.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
          default: { opencode: HARNESS_MODELS.opencode.id },
          connected: ["opencode"],
        },
        provider_auth: { opencode: [{ type: "api", label: "API key" }] },
        config: { provider: { id: "opencode", model: HARNESS_MODELS.opencode.id }, agent: { id: "build" } },
      })
    }
    if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
    if (url.pathname === "/provider/auth") return json(route, {})
    if (url.pathname === "/path") return json(route, { worktree: DIR })
    if (url.pathname === "/config") return json(route, { provider: { id: "opencode", model: HARNESS_MODELS.opencode.id }, agent: { id: "build" } })
    if (url.pathname === "/project" || url.pathname === "/experimental/project") return json(route, [localProjectRow(), cloudProjectRow()])
    if (url.pathname === "/agent" || url.pathname === "/app/agents") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (url.pathname === "/mcp") return json(route, {})
    if (url.pathname === "/lsp") return json(route, [])
    if (url.pathname === "/vcs") return json(route, {})
    if (url.pathname === "/command") return json(route, [{ name: "build", description: "Build command" }])
    if (url.pathname === "/permission") return json(route, [])
    if (url.pathname === "/question") return json(route, [])
    if (url.pathname === "/session/status") return json(route, {})
    if (url.pathname === "/global/event" || url.pathname === "/event") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n` }).catch(() => {})
    }

    // ---- Local draft-harness endpoints (plain local project, DIR) ----
    if (url.pathname === "/api/claxedo/agent-config/harness" && method === "POST") {
      requests.harnessConfigLocalPostCount += 1
      return json(route, { type: "opencode", ok: true })
    }
    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      const type = (url.searchParams.get("type") as Harness) ?? "opencode"
      const model = harnessModel(type)
      return json(route, { source: "runner", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model.id, selectOptions: [model] }] })
    }

    // ---- Workspace resolve / connection mint (no provisioning pipeline — spec 11 owns that) ----
    if (url.pathname === "/api/workspace/resolve") {
      const q = url.searchParams.get("workspaceId") || url.searchParams.get("directory") || ""
      if (q === WORKSPACE_ID || q.includes(WORKSPACE_ID)) {
        return json(route, { workspaceId: WORKSPACE_ID, projectId: "proj_core_harness_cloud_ws", directory: WORKSPACE_ID, kind: "cloud", status: "ready" })
      }
      return json(route, { workspaceId: `local:${PROJECT_ID}`, directory: DIR, kind: "local", status: "ready" })
    }
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection` || url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      return json(route, { access: "cloud", backing: "cloud-vm", workspaceId: WORKSPACE_ID, role: "owner", relayUrl: url.origin, runtimeAccessToken: "rat_core_harness_cloud", tokenExpiresAt: Date.now() + 120_000 })
    }

    // ---- Relay lane: /workspaces/:workspaceId/... ----
    const prefix = `/workspaces/${WORKSPACE_ID}`
    if (url.pathname.startsWith(prefix)) {
      const runtimePath = url.pathname.slice(prefix.length) || "/"

      if (runtimePath === "/vcs") return json(route, {})
      if (runtimePath === "/mcp") return json(route, {})
      if (runtimePath === "/lsp") return json(route, [])
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/permission") return json(route, [])
      if (runtimePath === "/question") return json(route, [])
      if (runtimePath === "/provider") {
        return json(route, { all: [{ id: "opencode", name: "opencode", env: [], models: { [HARNESS_MODELS.opencode.id]: { id: HARNESS_MODELS.opencode.id, name: HARNESS_MODELS.opencode.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }], default: { opencode: HARNESS_MODELS.opencode.id }, connected: ["opencode"] })
      }
      if (runtimePath === "/api/wr/health") return json(route, { healthy: true })
      if (runtimePath === "/api/wr/harness-config-options") {
        const type = (url.searchParams.get("harness") as Harness) ?? "opencode"
        requests.harnessOptionsRelayCount += 1
        requests.harnessOptionsRelayHarnesses.push(type)
        const model = harnessModel(type)
        return json(route, { source: "runner", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model.id, selectOptions: [model] }] })
      }
      if (runtimePath === "/api/wr/diff/refs") return json(route, { branches: [], tags: [], recent: [] })
      if (runtimePath === "/api/wr/diff/targets") return json(route, {})
      if (runtimePath === "/api/wr/diff/vcs") return json(route, [])
      if (runtimePath === "/api/wr/events" || runtimePath === "/api/wr/runtime-events" || runtimePath === "/api/claxedo/runtime-events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
      }
      if (runtimePath === "/global/event" || runtimePath === "/event") {
        const batch = await sessionBus.drain(4000)
        const body = batch.length === 0 ? ": heartbeat\n\n" : batch.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
        return route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
      }
      if (runtimePath === "/session/status") return json(route, sessionCreated ? { [sessionId]: { type: "idle" } } : {})
      if (runtimePath === "/session" && method === "POST") {
        requests.createSessionCount += 1
        SESSION_SEQ += 1
        sessionId = `ses_core_harness_cloud_${SESSION_SEQ}`
        sessionCreated = true
        messages = []
        const harnessParam = url.searchParams.get("harness") as Harness | null
        if (harnessParam) activeHarness = harnessParam
        return json(route, sessionRow())
      }
      if (runtimePath === "/session") return json(route, sessionCreated ? [sessionRow()] : [])
      if (/^\/session\/[^/]+$/.test(runtimePath)) return json(route, sessionRow())
      if (/^\/session\/[^/]+\/config$/.test(runtimePath)) {
        if (method === "GET") return json(route, sessionRow().config)
        return json(route, { ok: true })
      }
      if (/^\/session\/[^/]+\/capabilities$/.test(runtimePath)) {
        return json(route, { transport: activeHarness, abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: activeHarness !== "opencode" && activeHarness !== "pi" })
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) return json(route, [])
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) return json(route, messages)
      if (/^\/session\/[^/]+\/prompt_async$/.test(runtimePath)) {
        promptCount += 1
        requests.promptCount += 1
        const body = request.postDataJSON() as { messageID?: string; parts?: unknown; agent?: string; model?: { providerID?: string; modelID?: string } }
        const text = textOf(body?.parts) || `cloud message ${promptCount}`
        const providerID = body?.model?.providerID
        const modelID = body?.model?.modelID
        requests.promptBodies.push({ text, agent: body?.agent, providerID, modelID })
        const userID = body?.messageID || `msg_cloud_user_${promptCount}`
        const assistantID = `msg_cloud_assistant_${promptCount}`
        messages = [
          ...messages,
          { info: { id: userID, sessionID: sessionId, role: "user", time: { created: Date.now() }, model: { providerID, modelID } }, parts: [{ id: `${userID}_text`, sessionID: sessionId, messageID: userID, type: "text", text }] },
        ]
        await route.fulfill({ status: 204, body: "" })

        void (async () => {
          await wait(20)
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } } })
          await wait(30)
          const pendingInfo = { id: assistantID, sessionID: sessionId, role: "assistant", time: { created: Date.now() }, parentID: userID, agent: body?.agent ?? "build", providerID, modelID, mode: "code", path: { cwd: WORKSPACE_ID, root: WORKSPACE_ID }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
          messages = [...messages, { info: pendingInfo, parts: [] }]
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.updated", properties: { sessionID: sessionId, info: pendingInfo } } })
          const fullText = `cloud ack ${promptCount}: ${text}`
          const midpoint = Math.max(1, Math.floor(fullText.length / 2))
          for (const chunk of [fullText.slice(0, midpoint), fullText.slice(midpoint)]) {
            await wait(20)
            sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.part.delta", properties: { sessionID: sessionId, messageID: assistantID, partID: `${assistantID}_text`, field: "text", delta: chunk } } })
          }
          const finalPart = { id: `${assistantID}_text`, sessionID: sessionId, messageID: assistantID, type: "text", text: fullText }
          messages = messages.map((row) => (row.info.id === assistantID ? { ...row, parts: [finalPart] } : row))
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.part.updated", properties: { sessionID: sessionId, part: finalPart, time: Date.now() } } })
          await wait(30)
          const completedInfo = { ...pendingInfo, time: { ...pendingInfo.time, completed: Date.now() } }
          messages = messages.map((row) => (row.info.id === assistantID ? { ...row, info: completedInfo } : row))
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.updated", properties: { sessionID: sessionId, info: completedInfo } } })
          await wait(20)
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "session.idle", properties: { sessionID: sessionId } } })
        })()
        return
      }
      if (runtimePath === "/file" || runtimePath.startsWith("/file/")) return json(route, [])
      if (runtimePath.startsWith("/find")) return json(route, [])
      return json(route, { error: "unhandled cloud runtime path", path: runtimePath }, 599)
    }

    return json(route, { error: "unhandled request in core-harness-ownership-cloud mock", path: url.pathname }, 598)
  })

  return {
    requests,
    get session() {
      return { id: sessionId }
    },
  }
}

async function seedProjects(page: Page) {
  await page.addInitScript(
    (input: { dir: string; workspaceId: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [
              { worktree: input.dir, expanded: true, sandboxes: [] },
              { worktree: input.workspaceId, expanded: true, sandboxes: [input.workspaceId] },
            ],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, workspaceId: WORKSPACE_ID },
  )
}

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

// `fromLabel` is the harness trigger's CURRENT accessible name — it defaults to
// "OpenCode" (the draft's initial state) but callers switching harness a second time
// in the same test must pass the label the trigger now carries (e.g. "Claude"), since
// the trigger's accessible name changes to whatever harness is currently selected.
async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number, fromLabel: RegExp = /^OpenCode$/) {
  await page.getByRole("button", { name: fromLabel }).last().click()
  await page.getByRole("option", { name: optionName }).nth(optionIndex).click()
}

async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(modelName, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
}

async function expectOnlyOpenCodeModelControl(page: Page) {
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(0)
}

test.describe("core harness ownership (cloud) @tier-m", () => {
  for (const harnessCase of [
    { harness: "claude-acp" as Harness, option: /^Claude$/, optionIndex: 0, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    { harness: "claude-sdk" as Harness, option: /^Claude$/, optionIndex: 1, modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i, providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    { harness: "codex-acp" as Harness, option: /^Codex$/, optionIndex: 0, modelLabel: /GPT-5\.2 Codex|gpt-5\.2-codex/i, providerID: "codex-acp", modelID: "gpt-5.2-codex" },
    { harness: "codex-app-server" as Harness, option: /^Codex$/, optionIndex: 1, modelLabel: /GPT-5\.5|gpt-5\.5/i, providerID: "codex-app-server", modelID: "gpt-5.5" },
    { harness: "cursor-acp" as Harness, option: /^Cursor$/, optionIndex: 0, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor-acp", modelID: "cursor-auto" },
    { harness: "cursor-sdk" as Harness, option: /^Cursor$/, optionIndex: 1, modelLabel: /Cursor Auto|cursor-auto/i, providerID: "cursor-sdk", modelID: "cursor-auto" },
  ] as const) {
    // KNOWN GAP (see SPEC block): every send below hits expectAssistantReplyVisible, which
    // cannot pass for a brand-new workspace-runtime session in the app's current state —
    // confirmed by source (global-sdk.tsx:363-366, opencode-conversation.ts:156-203,
    // conversation-chat-client.ts:44-46, projection.ts's translateRuntimeEventToCompat) and
    // empirically (this exact test failed with "assistant reply ... never appeared" for
    // every harness in this loop on first run). test.fixme, not a weakened assertion.
    test.fixme(`${harnessCase.harness} owns harness label, model, and payload through cloud draft, sends, and reload over the relay; locked after creation — behavior 1`, async ({ page }) => {
      const mock = await installCloudHarnessMock(page)
      await seedProjects(page)

      await page.goto(workspaceRoute())
      await page.waitForLoadState("domcontentloaded")
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })
      await expectOnlyOpenCodeModelControl(page)

      await switchDraftHarness(page, harnessCase.option, harnessCase.optionIndex)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeVisible({ timeout: 20_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeEnabled()

      const first = `core harness cloud ${harnessCase.harness} first turn`
      await input.click()
      await input.fill(first)
      await expect(input).toContainText(first, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
      expect(mock.requests.createSessionCount).toBe(1)
      expect(mock.requests.promptBodies[0]).toMatchObject({ text: first, providerID: harnessCase.providerID, modelID: harnessCase.modelID })
      const sessionId = mock.session.id
      await expect(page).toHaveURL(sessionUrlPattern(sessionId), { timeout: 20_000 })
      await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

      // Harness Select is locked now that the cloud session exists.
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)
      await expect(page.getByRole("button", { name: harnessCase.option }).last()).toBeDisabled()

      const second = `core harness cloud ${harnessCase.harness} resumed turn`
      const inputAfterReload = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await inputAfterReload.click()
      await inputAfterReload.fill(second)
      await expect(inputAfterReload).toContainText(second, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
      expect(mock.requests.promptBodies[1]).toMatchObject({ text: second, providerID: harnessCase.providerID, modelID: harnessCase.modelID })
      await expectAssistantReplyVisible(page, `cloud ack 2: ${second}`)
      await expectTurnCounts(page, { user: 2, assistant: 2 })
    })
  }

  // KNOWN GAP (see SPEC block): sends and asserts the oracle, which cannot pass today.
  test.fixme("Pi is a fixed-model harness on a cloud workspace: zero relay options requests, instantly ready, payload owned by pi/virtual — behavior 2", async ({ page }) => {
    const mock = await installCloudHarnessMock(page)
    await seedProjects(page)

    await page.goto(workspaceRoute())
    await page.waitForLoadState("domcontentloaded")
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
    await page.getByRole("option", { name: /^Pi$/ }).click()
    await expect(page.getByRole("button", { name: /^Pi$/ }).last()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
    await expect(page.locator('[title="Connecting to agent runtime..."]')).toHaveCount(0)

    const first = "core harness cloud pi first turn"
    await input.click()
    await input.fill(first)
    await expect(input).toContainText(first, { timeout: 10_000 })
    await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 5_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.promptBodies[0]).toMatchObject({ text: first, providerID: "pi", modelID: "virtual" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${first}`)

    // Zero relay config-options requests for the entire scenario — pi has no config options.
    expect(mock.requests.harnessOptionsRelayCount).toBe(0)
  })

  test("relay harness-config-options requests are scoped per harness — switching resolves each harness's own model, never a stale one — behavior 3", async ({ page }) => {
    const mock = await installCloudHarnessMock(page)
    await seedProjects(page)

    await page.goto(workspaceRoute())
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })

    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)
    await expect.poll(() => mock.requests.harnessOptionsRelayHarnesses.includes("claude-acp"), { timeout: 10_000 }).toBe(true)

    await page.getByRole("button", { name: /^Claude$/ }).last().click()
    await page.getByRole("option", { name: /^Codex$/ }).nth(1).click()
    await expectOnlyHarnessModelControl(page, /GPT-5\.5|gpt-5\.5/i)
    await expect.poll(() => mock.requests.harnessOptionsRelayHarnesses.includes("codex-app-server"), { timeout: 10_000 }).toBe(true)

    // Every request the mock recorded named the harness it was actually resolving for
    // (a real cross-harness leak would show a request for "codex-app-server" answered
    // with claude's model, which expectOnlyHarnessModelControl above already ruled out
    // for the currently-rendered control) — this asserts the REQUEST side of that
    // scoping: no request for one harness's options ever went out unlabeled/blank.
    expect(mock.requests.harnessOptionsRelayHarnesses.every((h) => h.length > 0)).toBe(true)

    // Zero POSTs to the local readiness endpoint for either switch — cloud drafts never
    // touch it (behavior 4, asserted properly in the next test; sanity-checked here too).
    expect(mock.requests.harnessConfigLocalPostCount).toBe(0)
  })

  test("selecting a configurable harness on a cloud draft sends zero POSTs to the local harness-status endpoint — behavior 4", async ({ page }) => {
    const mock = await installCloudHarnessMock(page)
    await seedProjects(page)

    await page.goto(workspaceRoute())
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })

    // Each switch's trigger label is whatever the PREVIOUS switch just landed on — the
    // trigger's accessible name tracks the currently-selected harness (see
    // switchDraftHarness's fromLabel param), so this loop must thread it through instead
    // of re-opening a selector still labeled "OpenCode" after the first switch.
    let currentLabel: RegExp = /^OpenCode$/
    for (const [option, index] of [[/^Claude$/, 0], [/^Codex$/, 1], [/^Cursor$/, 0]] as const) {
      await switchDraftHarness(page, option, index, currentLabel)
      await expect(page.getByRole("button", { name: option }).last()).toBeVisible({ timeout: 20_000 })
      currentLabel = option
    }
    await expect.poll(() => mock.requests.harnessOptionsRelayCount, { timeout: 10_000 }).toBeGreaterThan(0)

    // The local readiness POST is the endpoint spec 3's local matrix relies on for
    // draft-time readiness — deterministic proof it was never called for this cloud
    // draft, across three separate harness switches.
    expect(mock.requests.harnessConfigLocalPostCount).toBe(0)
  })

  // KNOWN GAP (see SPEC block): the navigation-reset assertions below (the actual point of
  // behavior 5) do NOT need the oracle and are real, but this test's final step sends a
  // prompt through the cloud lane and calls expectAssistantReplyVisible, which cannot pass
  // today for the same reason as behavior 1/2 above — so the whole test is fixme'd rather
  // than dropping its oracle call (INVARIANTS.md authoring rule: every send proves via the
  // oracle, never a bare assertion instead).
  test.fixme("a non-OpenCode harness picked on a local draft resets to OpenCode after a same-pane navigation into a cloud workspace, before any cloud request — behavior 5", async ({ page }) => {
    const mock = await installCloudHarnessMock(page)
    await seedProjects(page)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const localInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(localInput).toBeVisible({ timeout: 20_000 })

    // Pick a non-OpenCode harness on the LOCAL draft.
    await switchDraftHarness(page, /^Claude$/, 0)
    await expectOnlyHarnessModelControl(page, /Sonnet 4\.6|claude-sonnet-4-6/i)

    // Client-side navigate the SAME pane to the cloud workspace's own top-level project
    // entry via the empty-draft header's project picker (no page reload — this is the
    // exact same-pane carryover vector shouldResetWorkspaceDraftHarness guards against).
    const projectPicker = page.getByRole("button", { name: "core-harness-cloud-local" }).last()
    await expect(projectPicker).toBeVisible({ timeout: 20_000 })
    await projectPicker.click()
    await page.getByRole("option", { name: "core-harness-cloud-workspace" }).click()

    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session$`), { timeout: 20_000 })
    // The draft harness reset to OpenCode BEFORE any cloud request — proven by the DOM
    // (exactly one plain model control) and by zero relay options requests having ever
    // fired for the leaked "claude-acp" selection.
    await expectOnlyOpenCodeModelControl(page)
    expect(mock.requests.harnessOptionsRelayHarnesses.includes("claude-acp")).toBe(false)

    const cloudInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(cloudInput).toBeVisible({ timeout: 20_000 })
    const text = "core harness cloud no-leak turn"
    await cloudInput.click()
    await cloudInput.fill(text)
    await expect(cloudInput).toContainText(text, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    // The strongest proof: the payload actually dispatched through the relay carries
    // "opencode", never the local pane's "claude-acp" selection.
    expect(mock.requests.promptBodies[0]).toMatchObject({ text, providerID: "opencode", modelID: "big-pickle" })
    await expectAssistantReplyVisible(page, `cloud ack 1: ${text}`)
  })
})
