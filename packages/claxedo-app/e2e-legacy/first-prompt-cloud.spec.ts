import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

// Flow #7 (real-browser E2E coverage): "Send first prompt in a cloud
// workspace session."
//
// Boots the shell in cloud workspace mode (signed user, control-plane backed
// session listing, runtime hosted behind the Workspace Relay), opens a
// fresh cloud session whose control-plane replay is empty, sends the very
// first user prompt, then asserts:
//   1. The cloud-mode shell paints and the prompt input is reachable.
//   2. Send dispatch goes through the Workspace Relay — not the local
//      runtime — at `POST .../workspaces/{id}/session/{id}/prompt_async`
//      with the cloud runtime access token attached.
//   3. The POST body carries the typed text, the agent, and the model the
//      workbench picked up from the cloud bootstrap.
//   4. The user turn renders in the timeline (optimistic + reconcile, no
//      duplicates).
//   5. No fallback to the legacy local runtime paths.
//   6. No console errors outside the Clerk dev-keys allowlist, and no
//      failed requests (modulo benign ERR_ABORTED on teardown).
//
// Setup mirrors cloud-runtime-relay-routing.spec.ts — the signed user
// + cloud workspace + Workspace Relay routing pattern that's already proven
// to drive a cloud bootstrap end-to-end. Only the assertions are different
// (this spec focuses on the first-prompt round-trip; cloud-runtime focuses
// on the per-pane routing contract).

const DIR = "/tmp/e2e-first-prompt-cloud"
const WORKSPACE_ID = "ws_first_prompt_cloud"
const PROJECT_ID = "proj_first_prompt_cloud"
const SIGNED_WORKSPACE_DIR = WORKSPACE_ID
const RELAY_ORIGIN = "https://relay.first-prompt-cloud.test"
const SESSION_ID = "cp-first-prompt-cloud-1"
const REPLAY_USER_ID = "msg_cp_seed_user"
const BIG_PICKLE = {
  id: "big-pickle",
  name: "Big Pickle",
  providerID: "opencode",
  cost: { input: 1, output: 1 },
}
type CloudHarness = "opencode" | "claude-acp" | "codex-acp"

const HARNESS_MODELS: Record<CloudHarness, { id: string; name: string; providerID: CloudHarness }> = {
  opencode: BIG_PICKLE,
  "claude-acp": { id: "claude-sonnet-4-6", name: "Sonnet 4.6", providerID: "claude-acp" },
  "codex-acp": { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", providerID: "codex-acp" },
}

type RelayHit = {
  method: string
  url: string
  authorization?: string
  body?: unknown
}

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  unhandled: RelayHit[]
  workspaceCreates: RelayHit[]
  relayRuntime: RelayHit[]
  controlPlaneEvents: RelayHit[]
  controlPlaneSessionMessages: RelayHit[]
  controlPlaneSessionEvents: RelayHit[]
  controlPlaneSessionCapabilities: RelayHit[]
  controlPlaneSessionLists: RelayHit[]
  controlPlaneWorkspaceLists: RelayHit[]
  connections: RelayHit[]
  forbiddenOldRuntime: RelayHit[]
}

type MessageRow = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    parentID?: string
    model?: { providerID: string; modelID: string }
    providerID?: string
    modelID?: string
  }
  parts: Array<{ id: string; sessionID: string; messageID: string; type: "text"; text: string }>
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

function sseEvent(input: unknown) {
  return `data: ${JSON.stringify(input)}\n\n`
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (!("type" in part) || part.type !== "text") return []
      if (!("text" in part) || typeof part.text !== "string") return []
      return [part.text]
    })
    .join("\n")
    .trim()
}

function turnMessages(input: { index: number; messageID: string; text: string; providerID: string; modelID: string }) {
  const user: MessageRow = {
    info: {
      id: input.messageID,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: Date.now() },
      model: { providerID: input.providerID, modelID: input.modelID },
    },
    parts: [{ id: `${input.messageID}_text`, sessionID: SESSION_ID, messageID: input.messageID, type: "text", text: input.text }],
  }
  const assistantID = `msg_cloud_assistant_${input.index}`
  const assistant: MessageRow = {
    info: {
      id: assistantID,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: input.messageID,
      providerID: input.providerID,
      modelID: input.modelID,
    },
    parts: [{
      id: `${assistantID}_text`,
      sessionID: SESSION_ID,
      messageID: assistantID,
      type: "text",
      text: `cloud ack ${input.index}: ${input.text}`,
    }],
  }
  return [user, assistant]
}

async function seed(page: Page) {
  // Match cloud-runtime-relay-routing.spec.ts's seed shape — signed user,
  // cloud workspace pre-registered in globalSync, and a directory pointing
  // at the workspace id selector the cloud route expects.
  await page.addInitScript((input: { projectDir: string; workspaceId: string; projectId: string }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: { serverUrl?: string; activeDirectory?: string }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: input.projectDir,
    }
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-browser-token"
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_USER__ = { id: "user_first_prompt_cloud" }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: input.projectDir, expanded: true, sandboxes: [] }] },
        lastProject: { local: input.projectId },
        workspaceServer: {},
        closedProjects: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:globalSync.project",
      JSON.stringify({
        value: [
          {
            id: input.projectId,
            name: "first-prompt-cloud",
            worktree: input.projectDir,
            sandboxes: [],
            workspaces: {},
          },
        ],
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: "opencode", modelID: "big-pickle" }],
        user: [],
        variant: {},
      }),
    )
  }, { projectDir: DIR, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

async function setup(page: Page, hits: Hits, options?: { workspaceCreated?: boolean; workspaceOptionsError?: string }) {
  const replayMessages: MessageRow[] = []
  let workspaceCreated = options?.workspaceCreated ?? false
  let sessionCreated = false
  let selectedHarness: CloudHarness = "opencode"
  const harnessModel = (harness = selectedHarness) => HARNESS_MODELS[harness]
  const providerCatalog = () =>
    Object.entries(HARNESS_MODELS).map(([id, model]) => ({
      id,
      name: id === "opencode" ? "OpenCode" : id === "claude-acp" ? "Claude" : "Codex",
      env: [],
      models: { [model.id]: model },
    }))
  const currentSessionConfig = () => {
    const model = harnessModel()
    return {
      harness: { type: selectedHarness, model: model.id, status: "ready", ready: true, workspaceId: WORKSPACE_ID },
      runner: { type: selectedHarness, model: model.id, status: "ready", ready: true, workspaceId: WORKSPACE_ID },
      model: { providerID: selectedHarness, modelID: model.id },
      agent: "build",
    }
  }

  const cloudProject = () => ({
    id: PROJECT_ID,
    name: "first-prompt-cloud",
    worktree: DIR,
    sandboxes: workspaceCreated ? [SIGNED_WORKSPACE_DIR] : [],
    workspaces: workspaceCreated
      ? {
          [SIGNED_WORKSPACE_DIR]: {
            id: WORKSPACE_ID,
            kind: "cloud",
            workspace_name: "main",
            directory: SIGNED_WORKSPACE_DIR,
          },
        }
      : {},
  })

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      hits.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => {
    hits.console.push(`pageerror: ${error.message}`)
  })
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).hostname.endsWith(".clerk.accounts.dev")) return
    hits.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("response", (response) => {
    const request = response.request()
    if (response.status() >= 400) {
      hits.badResponses.push(`${response.status()} ${request.resourceType()} ${request.method()} ${response.url()}`)
    }
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()

    const request = route.request()
    const url = new URL(request.url())
    const hit: RelayHit = {
      method: request.method(),
      url: request.url(),
      authorization: request.headers().authorization,
    }

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
      return
    }

    // ---- Workspace runtime lane (external relay or local control-server proxy) ----
    if (
      url.pathname.startsWith(`/workspaces/${WORKSPACE_ID}`) &&
      (url.hostname === "relay.first-prompt-cloud.test" || url.host === "127.0.0.1:3001")
    ) {
      const runtimePath = url.pathname.replace(`/workspaces/${WORKSPACE_ID}`, "")
      const body = request.method() === "POST" ? request.postDataJSON() : undefined
      hits.relayRuntime.push({ ...hit, body })

      if (runtimePath === "/vcs") {
        await json(route, { branch: "main", default_branch: "main" })
        return
      }
      if (runtimePath === "/api/wr/health") {
        await json(route, { healthy: true, version: "1.0.0-test" })
        return
      }
      if (runtimePath === "/mcp") {
        await json(route, {})
        return
      }
      if (runtimePath === "/lsp") {
        await json(route, [])
        return
      }
      if (runtimePath === "/agent") {
        await json(route, [{ id: "build", name: "build", description: "Default agent", mode: "primary" }])
        return
      }
      if (runtimePath === "/command") {
        await json(route, [])
        return
      }
      if (runtimePath === "/provider") {
        await json(route, {
          all: providerCatalog(),
          connected: Object.keys(HARNESS_MODELS),
          default: Object.fromEntries(Object.entries(HARNESS_MODELS).map(([id, model]) => [id, model.id])),
        })
        return
      }
      if (runtimePath === "/api/wr/harness-config-options") {
        const requestedHarness = (url.searchParams.get("harness") as CloudHarness | null) ?? selectedHarness
        if (options?.workspaceOptionsError && requestedHarness !== "opencode") {
          await json(route, { error: options.workspaceOptionsError }, 401)
          return
        }
        const model = harnessModel(requestedHarness)
        await json(route, {
          source: "runner",
          stale: false,
          options: [{
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: model.id,
            selectOptions: [{ id: model.id, name: model.name }],
          }],
        })
        return
      }
      if (
        runtimePath === "/api/claxedo/runtime-events" ||
        runtimePath === "/api/wr/events" ||
        runtimePath === "/api/wr/runtime-events"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body: sseEvent({ type: "heartbeat" }),
        })
        return
      }
      if (runtimePath === "/permission" || runtimePath === "/question") {
        await json(route, [])
        return
      }
      if (runtimePath === "/session") {
        if (request.method() === "POST") {
          sessionCreated = true
          await json(route, {
            id: SESSION_ID,
            sessionID: SESSION_ID,
            title: "First prompt cloud session",
            time: { created: 1, updated: 2 },
            directory: SIGNED_WORKSPACE_DIR,
          })
          return
        }
        await json(route, sessionCreated ? [{
          id: SESSION_ID,
          sessionID: SESSION_ID,
          title: "First prompt cloud session",
          time: { created: 1, updated: 2 },
          directory: SIGNED_WORKSPACE_DIR,
        }] : [])
        return
      }
      if (runtimePath === "/session/status") {
        await json(route, { [SESSION_ID]: { type: "idle" } })
        return
      }
      if (/^\/session\/[^/]+$/.test(runtimePath)) {
        await json(route, {
          id: decodeURIComponent(runtimePath.split("/")[2] ?? ""),
          title: "First prompt cloud session",
        })
        return
      }
      if (/^\/session\/[^/]+\/config$/.test(runtimePath)) {
        if (request.method() === "GET") {
          await json(route, currentSessionConfig())
          return
        }
        const body = request.postDataJSON() as { harness?: { type?: CloudHarness }; model?: { providerID?: CloudHarness; modelID?: string } }
        selectedHarness = body.harness?.type ?? body.model?.providerID ?? selectedHarness
        await json(route, { ok: true })
        return
      }
      if (/^\/session\/[^/]+\/capabilities$/.test(runtimePath)) {
        await json(route, {
          transport: "claude-acp",
          abort: true,
          reconnect: true,
          replay: true,
          permissions: false,
          questions: false,
          todos: false,
          commands: false,
          fork: true,
          revert: false,
          unrevert: false,
          configOptions: false,
        })
        return
      }
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) {
        await json(route, { messages: replayMessages })
        return
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) {
        await json(route, [])
        return
      }
      if (runtimePath === "/global/event" || runtimePath === "/event") {
        hits.controlPlaneSessionEvents.push(hit)
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body: sseEvent({ directory: "global", payload: { type: "server.connected", properties: {} } }),
        })
        return
      }
      if (/^\/session\/[^/]+\/prompt_async$/.test(runtimePath)) {
        const body = request.postDataJSON() as {
          messageID?: string
          parts?: unknown
          model?: { providerID?: string; modelID?: string }
        }
        const text = textOf(body.parts) || `cloud message ${replayMessages.length / 2 + 1}`
        const model = body.model?.providerID && body.model.modelID
          ? { providerID: body.model.providerID, modelID: body.model.modelID }
          : { providerID: selectedHarness, modelID: harnessModel().id }
        replayMessages.push(...turnMessages({
          index: replayMessages.length / 2 + 1,
          messageID: body.messageID || `msg_cloud_user_${replayMessages.length / 2 + 1}`,
          text,
          ...model,
        }))
        await route.fulfill({ status: 204, body: "" })
        return
      }
      if (runtimePath === "/file" || runtimePath === "/file/status" || runtimePath.startsWith("/file/")) {
        await json(route, [])
        return
      }
      if (runtimePath === "/api/wr/diff/refs") {
        await json(route, { branches: ["main"], tags: [], recent: [] })
        return
      }
      if (runtimePath === "/api/wr/diff/targets") {
        await json(route, { defaultRef: "origin/dev", candidates: ["origin/dev"] })
        return
      }
      if (runtimePath === "/api/wr/diff/vcs") {
        await json(route, [])
        return
      }
      if (runtimePath.startsWith("/find")) {
        await json(route, [])
        return
      }
      hits.unhandled.push(hit)
      await json(route, { error: "unhandled relay runtime path" }, 599)
      return
    }

    // ---- Workspace connection mint / refresh ----
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection`) {
      hits.connections.push(hit)
      await json(route, {
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: WORKSPACE_ID,
        role: "owner",
        relayUrl: RELAY_ORIGIN,
        runtimeAccessToken: "rat_first_prompt_cloud",
        tokenExpiresAt: Date.now() + 120_000,
      })
      return
    }
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      hits.connections.push(hit)
      await json(route, {
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: WORKSPACE_ID,
        role: "owner",
        relayUrl: RELAY_ORIGIN,
        runtimeAccessToken: "rat_first_prompt_cloud_refreshed",
        tokenExpiresAt: Date.now() + 120_000,
      })
      return
    }
    if (url.pathname === "/api/workspace/create" && request.method() === "POST") {
      workspaceCreated = true
      hits.workspaceCreates.push({ ...hit, body: request.postDataJSON() })
      await json(route, {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        directory: SIGNED_WORKSPACE_DIR,
        provider: "modal",
        status: "ready",
      })
      return
    }
    if (
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/register` ||
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/checkpoint`
    ) {
      await json(route, { ok: true })
      return
    }

    // ---- Control plane: workspaces + sessions catalog ----
    if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "cloud") {
      hits.controlPlaneWorkspaceLists.push(hit)
      await json(route, {
        workspaces: workspaceCreated ? [
          {
            workspace_id: WORKSPACE_ID,
            project_id: PROJECT_ID,
            backing: "cloud-vm",
            access: "cloud",
            display_name: "First prompt cloud workspace",
          },
        ] : [],
      })
      return
    }
    if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "user-hosted") {
      hits.controlPlaneWorkspaceLists.push(hit)
      await json(route, { workspaces: [] })
      return
    }
    if (url.pathname === "/api/workspace/resolve") {
      const requestedDirectory = url.searchParams.get("directory")
      const requestedWorkspaceId = url.searchParams.get("workspaceId")
      if (
        workspaceCreated &&
        (requestedDirectory === SIGNED_WORKSPACE_DIR || requestedWorkspaceId === WORKSPACE_ID)
      ) {
        await json(route, {
          workspaceId: WORKSPACE_ID,
          directory: SIGNED_WORKSPACE_DIR,
          kind: "cloud",
          status: "ready",
        })
        return
      }
      await json(route, {
        workspaceId: `local:${PROJECT_ID}`,
        directory: requestedDirectory || DIR,
        kind: "local",
        status: "ready",
      })
      return
    }
    if (url.pathname === "/api/control/session-list") {
      hits.controlPlaneSessionLists.push(hit)
      const rows = sessionCreated ? [
        {
          type: "session",
          sessionRef: `workspace:${WORKSPACE_ID}:session:${SESSION_ID}`,
          sessionId: SESSION_ID,
          title: "First prompt cloud session",
          directory: SIGNED_WORKSPACE_DIR,
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          createdAt: 1,
          updatedAt: 2,
          tags: [],
          attachments: [],
          harness: { type: selectedHarness, model: harnessModel().id, status: "ready", ready: true },
        },
      ] : []
      await json(route, {
        view: {
          scope: url.searchParams.get("scope") ?? "workspace",
          groupBy: url.searchParams.get("groupBy") ?? "none",
          sort: "updated_desc",
          limit: Number(url.searchParams.get("limit") ?? "5"),
        },
        items: rows,
        totalKnown: rows.length,
      })
      return
    }
    if (url.pathname === "/api/control/sessions") {
      hits.controlPlaneSessionLists.push(hit)
      await json(route, {
        sessions: sessionCreated ? [
          {
            session_id: SESSION_ID,
            title: "First prompt cloud session",
            created_at: 1,
            updated_at: 2,
            harness: { type: selectedHarness, model: harnessModel().id, status: "ready", ready: true },
          },
        ] : [],
      })
      return
    }

    // ---- Control plane: per-session capabilities / messages / events ----
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/capabilities`) {
      hits.controlPlaneSessionCapabilities.push(hit)
      await json(route, {
        transport: "claude-acp",
        abort: true,
        reconnect: true,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: true,
        revert: false,
        unrevert: false,
        configOptions: false,
      })
      return
    }
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/gateway`) {
      await json(route, { gatewayUrl: null })
      return
    }
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/messages`) {
      hits.controlPlaneSessionMessages.push(hit)
      await json(route, { messages: replayMessages })
      return
    }

    // ---- Compat / bootstrap (cloud-mode) ----
    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }
    if (url.pathname === "/api/claxedo/bootstrap") {
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "" },
        project: [cloudProject()],
        provider: {
          all: providerCatalog(),
          default: Object.fromEntries(Object.entries(HARNESS_MODELS).map(([id, model]) => [id, model.id])),
          connected: Object.keys(HARNESS_MODELS),
        },
        provider_auth: {},
        config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
        workspaceMode: "cloud",
        remoteAccess: { enabled: true },
      })
      return
    }
    if (url.pathname === "/api/claxedo/events") {
      hits.controlPlaneEvents.push(hit)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ directory: "global", payload: { type: "server.connected", properties: {} } }),
      })
      return
    }
    if (url.pathname === "/api/wr/events") {
      hits.controlPlaneEvents.push(hit)
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ directory: "global", payload: { type: "server.connected", properties: {} } }),
      })
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as { type?: CloudHarness } | undefined
        selectedHarness = body?.type ?? selectedHarness
      }
      const model = harnessModel()
      await json(route, { type: selectedHarness, model: model.id, status: "ready", ready: true })
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      const model = harnessModel((url.searchParams.get("type") as CloudHarness | null) ?? selectedHarness)
      await json(route, {
        source: "runner",
        stale: false,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: model.id,
            selectOptions: [{ id: model.id, name: model.name }],
          },
        ],
      })
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/commands") {
      await json(route, [])
      return
    }

    // The test starts from the project root so the shell can exercise the
    // user's cloud toggle. These reads are local project bootstrap; cloud
    // session creation and prompt dispatch are still asserted on the relay lane.
    if (url.pathname === "/provider") {
      await json(route, {
        all: providerCatalog(),
        connected: Object.keys(HARNESS_MODELS),
        default: Object.fromEntries(Object.entries(HARNESS_MODELS).map(([id, model]) => [id, model.id])),
      })
      return
    }
    if (url.pathname === "/config" || url.pathname === "/global/config") {
      await json(route, {
        provider: { id: "opencode", model: "big-pickle" },
        agent: "build",
      })
      return
    }
    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }
    if (url.pathname === "/vcs") {
      await json(route, { branch: "main", default_branch: "main" })
      return
    }
    if (url.pathname === "/project/current") {
      await json(route, cloudProject())
      return
    }
    if (url.pathname === `/project/${PROJECT_ID}` && request.method() === "PATCH") {
      await json(route, cloudProject())
      return
    }
    if (url.pathname === "/session" && request.method() === "GET") {
      await json(route, [])
      return
    }
    if (url.pathname === "/session/status" && request.method() === "GET") {
      await json(route, sessionCreated ? { [SESSION_ID]: { type: "idle" } } : {})
      return
    }
    if (url.pathname === "/permission" || url.pathname === "/question") {
      await json(route, [])
      return
    }
    if (url.pathname === "/api/wr/diff/refs") {
      await json(route, { branches: ["main"], tags: [], recent: [] })
      return
    }
    if (url.pathname === "/api/wr/diff/targets") {
      await json(route, { defaultRef: "origin/dev", candidates: ["origin/dev"] })
      return
    }
    if (url.pathname === "/api/wr/diff/vcs") {
      await json(route, [])
      return
    }
    // ---- Anything else (old local runtime paths) is a regression ----
    if (
      url.pathname === "/global/event" ||
      url.pathname === "/event" ||
      url.pathname === "/path" ||
      url.pathname === "/project" ||
      url.pathname === "/project/current" ||
      url.pathname === "/config" ||
      url.pathname === "/global/config" ||
      url.pathname === "/app/agents" ||
      url.pathname === "/agent" ||
      url.pathname === "/command" ||
      url.pathname === "/mcp" ||
      url.pathname === "/lsp" ||
      url.pathname === "/vcs" ||
      url.pathname.startsWith("/file") ||
      url.pathname.startsWith("/find") ||
      url.pathname === "/provider" ||
      url.pathname === "/provider/auth" ||
      url.pathname === "/session" ||
      url.pathname.startsWith("/session/") ||
      url.pathname === "/experimental/session" ||
      url.pathname.startsWith("/api/claxedo/hook")
    ) {
      hits.forbiddenOldRuntime.push(hit)
      await json(route, { error: "old local runtime path used in cloud-mode shell" }, 599)
      return
    }

    hits.unhandled.push(hit)
    await json(route, { error: "unhandled cloud-mode browser API request" }, 598)
  })
}

function expectNoRouteStackOverflow(hits: Hits) {
  expect(
    hits.console.filter((item) =>
      /Maximum call stack size exceeded|RangeError|open-surface-actions-ui|ClaxedoLayout/.test(item),
    ),
  ).toEqual([])
}

function nonClerkConsole(hits: Hits) {
  return hits.console.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_FAILED"),
  )
}

function nonAbortFailures(hits: Hits) {
  return hits.failed.filter((item) => !item.endsWith(" net::ERR_ABORTED"))
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

function literalText(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
}

async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(
    typeof modelName === "string" ? literalText(modelName) : modelName,
    { timeout: 20_000 },
  )
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveCount(0)
}

test("core cloud vm unavailable harness does not fall back to OpenCode controls @core", async ({ page }) => {
  const hits: Hits = {
    console: [],
    failed: [],
    badResponses: [],
    unhandled: [],
    workspaceCreates: [],
    relayRuntime: [],
    controlPlaneEvents: [],
    controlPlaneSessionMessages: [],
    controlPlaneSessionEvents: [],
    controlPlaneSessionCapabilities: [],
    controlPlaneSessionLists: [],
    controlPlaneWorkspaceLists: [],
    connections: [],
    forbiddenOldRuntime: [],
  }

  await seed(page)
  await setup(page, hits, {
    workspaceCreated: true,
    workspaceOptionsError: "Authentication required. Please run 'agent login' first.",
  })
  await page.goto(`/w/${encodeURIComponent(WORKSPACE_ID)}/session`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: /^Claude$/ }).first().click()
  await expect(page.getByRole("button", { name: /^Claude$/ }).last()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(/Unavailable|Select model/i, { timeout: 20_000 })
  await expect(page.locator("[aria-label=\"Authentication required. Please run 'agent login' first.\"]")).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveCount(0)

  await composePrompt(page, input, "should not send")
  await expect(page.locator('[data-action="prompt-submit"]').last()).toBeDisabled()
  await page.waitForTimeout(250)
  expect(hits.workspaceCreates).toEqual([])
  expect(
    hits.relayRuntime.filter((item) =>
      item.method === "POST" && new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session`
    ),
  ).toEqual([])
  expect(
    hits.relayRuntime.filter((item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`
    ),
  ).toEqual([])
  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonAbortFailures(hits)).toEqual([])
})

test("core cloud workspace session posts through relay and resumes after reload @core", async ({ page }) => {
  const hits: Hits = {
    console: [],
    failed: [],
    badResponses: [],
    unhandled: [],
    workspaceCreates: [],
    relayRuntime: [],
    controlPlaneEvents: [],
    controlPlaneSessionMessages: [],
    controlPlaneSessionEvents: [],
    controlPlaneSessionCapabilities: [],
    controlPlaneSessionLists: [],
    controlPlaneWorkspaceLists: [],
    connections: [],
    forbiddenOldRuntime: [],
  }

  await seed(page)
  await setup(page, hits)

  await page.goto(`/${slug(DIR)}/session`, { waitUntil: "domcontentloaded" })

  // Shell paints on the project root before submit provisions the cloud workspace.
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(
    new RegExp(`/(?:${slug(DIR)}/session|w/(?:${encodeURIComponent(DIR)}|local%3A${PROJECT_ID})(?:/session)?)$`),
  )

  const promptVisible = await page
    .getByRole("textbox", { name: /Ask anything/i })
    .isVisible()
    .catch(() => false)
  if (!promptVisible) {
    await page.getByRole("button", { name: /New session/i }).first().click()
  }

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  try {
    await expect(input).toBeVisible({ timeout: 20_000 })
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}

Relay runtime:
${hits.relayRuntime.map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}

Control plane sessions:
${[
  ...hits.controlPlaneSessionLists,
  ...hits.controlPlaneSessionCapabilities,
  ...hits.controlPlaneSessionMessages,
  ...hits.controlPlaneSessionEvents,
].map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}

Forbidden:
${hits.forbiddenOldRuntime.map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}

Unhandled:
${hits.unhandled.map((item) => `${item.method} ${item.url}`).join("\n") || "(none)"}

Console:
${hits.console.join("\n") || "(none)"}`)
  }
  await expect(input).toHaveAttribute("contenteditable", "true")

  const environment = page.getByRole("group", { name: "Workspace environment" })
  await environment.getByRole("button", { name: "cloud" }).click()
  await expect(environment.getByRole("button", { name: "cloud" })).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("group", { name: "Workspace source" }).getByRole("button", { name: "Create new" }),
  ).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByText("New cloud sandbox", { exact: true })).toBeVisible()

  const first = "core cloud first turn through relay"
  const second = "core cloud resumed second turn"
  await composePrompt(page, input, first)
  const submit = page.locator('[data-action="prompt-submit"]').last()
  await expect(submit).toBeVisible({ timeout: 10_000 })
  await submit.click()

  await expect.poll(() => hits.workspaceCreates.length, { timeout: 20_000 }).toBe(1)
  expect(hits.workspaceCreates[0]?.authorization).toBe("Bearer signed-browser-token")
  expect(hits.workspaceCreates[0]?.body).toEqual({ projectId: PROJECT_ID })

  // The prompt POST landed on the workspace runtime lane. In local e2e this is
  // the control-server `/workspaces/:id` proxy; hosted centrals use the relay
  // URL. The architectural promise is that cloud submits never hit bare local
  // runtime paths.
  await expect
    .poll(
      () =>
        hits.relayRuntime.some(
          (item) =>
            item.method === "POST" &&
            new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
        ),
      { timeout: 20_000 },
    )
    .toBe(true)

  const promptHit = hits.relayRuntime.find(
    (item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
  )
  expect(
    promptHit?.authorization === "Bearer rat_first_prompt_cloud" ||
      promptHit?.authorization === "Bearer signed-browser-token",
  ).toBe(true)

  // Connection mint actually happened as a side-effect of the relay POST.
  expect(hits.connections.length).toBeGreaterThan(0)

  const body = promptHit?.body as
    | { messageID?: string; parts?: unknown; agent?: string; model?: { providerID?: string; modelID?: string } }
    | undefined
  expect(textOf(body?.parts)).toBe(first)
  expect(typeof body?.messageID === "string" && body!.messageID!.length > 0).toBe(true)
  expect(body?.model?.providerID).toBe("opencode")
  expect(body?.model?.modelID).toBe("big-pickle")

  // Optimistic user turn renders in the timeline.
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(first, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })

  const userTurns = await page
    .locator('[data-slot="session-turn-message-content"]')
    .getByText(first, { exact: true })
    .count()
  expect(userTurns).toBe(1)

  await composePrompt(page, input, second)
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect
    .poll(
      () =>
        hits.relayRuntime.filter(
          (item) =>
            item.method === "POST" &&
            new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
        ).length,
      { timeout: 20_000 },
    )
    .toBe(2)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(first, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(second, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(`cloud ack 2: ${second}`, { exact: true })).toBeVisible({ timeout: 20_000 })

  // Hard contract: nothing fell back to the legacy local runtime paths.
  expect(hits.forbiddenOldRuntime).toEqual([])

  // Cloud-mode auth contract: control-plane traffic carried the signed user
  // token, and the submit POST above carried the relay runtime token when it
  // used the external relay. Local workspace-proxy reads may be unsigned.
  const signedAuth = "Bearer signed-browser-token"
  expect(hits.controlPlaneSessionCapabilities.every((item) => item.authorization === signedAuth)).toBe(true)
  expect(hits.controlPlaneSessionMessages.every((item) => item.authorization === signedAuth)).toBe(true)

  // No noise / regressions.
  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonAbortFailures(hits)).toEqual([])
})

for (const harnessCase of [
  {
    label: "Claude",
    option: /^Claude$/,
    providerID: "claude-acp",
    modelID: "claude-sonnet-4-6",
    modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
  },
  {
    label: "Codex",
    option: /^Codex$/,
    providerID: "codex-acp",
    modelID: "gpt-5.2-codex",
    modelLabel: /GPT-5\.2 Codex|gpt-5\.2-codex/i,
  },
] as const) {
test(`core cloud vm ${harnessCase.label} harness model ownership survives create, reload, and follow-up @core`, async ({ page }) => {
  const hits: Hits = {
    console: [],
    failed: [],
    badResponses: [],
    unhandled: [],
    workspaceCreates: [],
    relayRuntime: [],
    controlPlaneEvents: [],
    controlPlaneSessionMessages: [],
    controlPlaneSessionEvents: [],
    controlPlaneSessionCapabilities: [],
    controlPlaneSessionLists: [],
    controlPlaneWorkspaceLists: [],
    connections: [],
    forbiddenOldRuntime: [],
  }

  await seed(page)
  await setup(page, hits)
  await page.goto(`/${slug(DIR)}/session`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const promptVisible = await page
    .getByRole("textbox", { name: /Ask anything/i })
    .isVisible()
    .catch(() => false)
  if (!promptVisible) {
    await page.getByRole("button", { name: /New session/i }).first().click()
  }
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })

  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: harnessCase.option }).first().click()
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  const environment = page.getByRole("group", { name: "Workspace environment" })
  await environment.getByRole("button", { name: "cloud" }).click()
  await expect(environment.getByRole("button", { name: "cloud" })).toHaveAttribute("aria-pressed", "true")

  const first = `core cloud ${harnessCase.label.toLowerCase()} first`
  const second = `core cloud ${harnessCase.label.toLowerCase()} second`
  const third = `core cloud ${harnessCase.label.toLowerCase()} after reload`
  await composePrompt(page, input, first)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect
    .poll(
      () =>
        hits.relayRuntime.filter(
          (item) =>
            item.method === "POST" &&
            new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
        ).length,
      { timeout: 20_000 },
    )
    .toBe(1)

  const firstPrompt = hits.relayRuntime.find(
    (item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
  )?.body as { model?: { providerID?: string; modelID?: string }; parts?: unknown; variant?: string } | undefined
  expect(textOf(firstPrompt?.parts)).toBe(first)
  expect(firstPrompt?.model).toEqual({ providerID: harnessCase.providerID, modelID: harnessCase.modelID })
  expect(firstPrompt?.variant).toBeUndefined()
  const workspaceOptionRequests = hits.relayRuntime.filter((item) =>
    new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/api/wr/harness-config-options`
  )
  expect(workspaceOptionRequests.every((item) => new URL(item.url).searchParams.get("harness") === harnessCase.providerID)).toBe(true)
  await expect(page.getByText(`cloud ack 1: ${first}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), second)
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect
    .poll(
      () =>
        hits.relayRuntime.filter(
          (item) =>
            item.method === "POST" &&
            new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
        ).length,
      { timeout: 20_000 },
    )
    .toBe(2)
  const secondPrompt = hits.relayRuntime.filter(
    (item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
  ).at(-1)?.body as { model?: { providerID?: string; modelID?: string }; parts?: unknown; variant?: string } | undefined
  expect(textOf(secondPrompt?.parts)).toBe(second)
  expect(secondPrompt?.model).toEqual({ providerID: harnessCase.providerID, modelID: harnessCase.modelID })
  expect(secondPrompt?.variant).toBeUndefined()
  await expect(page.getByText(`cloud ack 2: ${second}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), third)
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect
    .poll(
      () =>
        hits.relayRuntime.filter(
          (item) =>
            item.method === "POST" &&
            new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
        ).length,
      { timeout: 20_000 },
    )
    .toBe(3)
  const thirdPrompt = hits.relayRuntime.filter(
    (item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${WORKSPACE_ID}/session/${SESSION_ID}/prompt_async`,
  ).at(-1)?.body as { model?: { providerID?: string; modelID?: string }; parts?: unknown; variant?: string } | undefined
  expect(textOf(thirdPrompt?.parts)).toBe(third)
  expect(thirdPrompt?.model).toEqual({ providerID: harnessCase.providerID, modelID: harnessCase.modelID })
  expect(thirdPrompt?.variant).toBeUndefined()

  expect(hits.forbiddenOldRuntime).toEqual([])
  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonAbortFailures(hits)).toEqual([])
})
}
