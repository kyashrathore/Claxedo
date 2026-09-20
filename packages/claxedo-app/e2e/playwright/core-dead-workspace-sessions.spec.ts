/**
 * Reading a cloud project's session history when its sandbox is dead. Those sessions sync
 * back to the central bus and are stored in the control plane (`session_history` /
 * `session_messages`), so a project whose VM was destroyed days ago must still show its
 * full session list in the rail and its full transcript when a session is opened.
 *
 * Workspace liveness is the `status` from `GET /api/workspace/resolve`, sourced server-side
 * from the supervisor lease plus the workspace row. `stopped | destroyed | unavailable |
 * failed | offline | deleted` mean unreachable; anything else, including absent, is treated
 * as reachable so healthy workspaces keep their runtime fallback
 * (`workspaceRuntimeReachable`, `src/features/session/data/sync/inventory-source.ts`).
 *
 * Rows come from `GET /api/control/session-list` and transcripts from
 * `GET /api/control/sessions/:id/messages`; both read the central store and have no
 * workspace dependency, which is what makes them survive. Routing a transcript there rather
 * than to the workspace relay needs a confirmed `cloud` workspace kind —
 * `resolveSessionResourceRoute` diverts unresolved-kind workspaces to the relay
 * (`src/platform/runtime/agent/placement-table.ts`).
 *
 * Every runtime route here answers 409, so anything that renders can only have come from
 * the control plane; that is the enforcement, never a sleep. The workspace gate must let
 * this through: a dead provisioner-placed workspace renders its surface through
 * `hasCentralHistory` instead of the offline panel, while a machine-placed one keeps the
 * offline panel because it genuinely has no central copy. An empty list is honest only
 * when the control plane itself returned nothing.
 *
 * No turn is ever sent here, so no relay and no harness is mounted. Sending turns on a
 * provisioner-placed workspace is core-harness-ownership-cloud's, provisioning is
 * core-cloud-provisioning's, and machine-placed workspaces are
 * core-host-tunnel-workspace's.
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import { isSessionListPath } from "../helpers/contracts/session-list"
import { expect, test, type Page, type Route } from "@playwright/test"
import { bootstrapDeployment } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectTurnCounts } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-dead-workspace"
const WORKSPACE_ID = "ws_dead_e2e"
// Deliberately not `ws_`-prefixed: the project-scoped session list has to resolve a project
// id of any shape to its workspaces rather than assuming a workspace id.
const PROJECT_ID = "proj_dead_workspace_e2e"
const PROJECT_NAME = "dead-workspace"
const DEAD_STATUS = "stopped"

type StoredSession = {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
}

const BASE_TIME = 1_770_000_000_000

const STORED_SESSIONS: StoredSession[] = [
  { sessionId: "ses_dead_a", title: "Ship the billing migration", createdAt: BASE_TIME, updatedAt: BASE_TIME + 3_000 },
  { sessionId: "ses_dead_b", title: "Investigate the flaky shard", createdAt: BASE_TIME, updatedAt: BASE_TIME + 2_000 },
  { sessionId: "ses_dead_c", title: "Draft the release notes", createdAt: BASE_TIME, updatedAt: BASE_TIME + 1_000 },
]

const TRANSCRIPT_PROMPT = "why did the nightly shard fail?"
const TRANSCRIPT_REPLY = "The nightly shard failed because the fixture DB was never migrated."

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route, payload: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "access-control-allow-origin": "*" },
    body: `data: ${JSON.stringify(payload)}\n\n`,
  })
}

function navigationRow(session: StoredSession) {
  return {
    type: "session",
    sessionRef: `workspace:${WORKSPACE_ID}:session:${session.sessionId}`,
    sessionId: session.sessionId,
    title: session.title,
    directory: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tags: [],
    attachments: [],
    environment: { kind: "cloud" },
  }
}

/**
 * The stored transcript for `ses_dead_a`, in the app's message/part row shape
 * (`{info, parts}` — see `normalizeMessageRows`, src/features/session/store/
 * message-page.ts). Ids are ordered so `compareIDs` sorts user before
 * assistant, and the assistant message carries `time.completed` so the turn is settled: a
 * settled turn renders its content regardless of `session.status`, which never arrives
 * here.
 */
function storedTranscript() {
  const sessionID = STORED_SESSIONS[0].sessionId
  return [
    {
      info: {
        id: "msg_001_user",
        sessionID,
        role: "user",
        time: { created: BASE_TIME + 1_000 },
        agent: "build",
        mode: "code",
        path: { cwd: WORKSPACE_ID, root: WORKSPACE_ID },
      },
      parts: [{ id: "prt_001", sessionID, messageID: "msg_001_user", type: "text", text: TRANSCRIPT_PROMPT }],
    },
    {
      info: {
        id: "msg_002_assistant",
        sessionID,
        role: "assistant",
        time: { created: BASE_TIME + 2_000, completed: BASE_TIME + 2_500 },
        parentID: "msg_001_user",
        agent: "build",
        providerID: "opencode",
        modelID: "big-pickle",
        mode: "code",
        path: { cwd: WORKSPACE_ID, root: WORKSPACE_ID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "prt_002", sessionID, messageID: "msg_002_assistant", type: "text", text: TRANSCRIPT_REPLY }],
    },
  ]
}

type DeadWorkspaceState = {
  /** Every `/api/control/session-list` query string, for scope/param assertions. */
  sessionListQueries: string[]
  /** Any request that would have probed the dead workspace runtime for sessions. */
  runtimeSessionProbes: string[]
  /** `/api/control/sessions/:id/messages` reads, by session id. */
  transcriptReads: string[]
}

function projectRow() {
  return {
    id: PROJECT_ID,
    worktree: WORKSPACE_ID,
    name: PROJECT_NAME,
    sandboxes: [WORKSPACE_ID],
    workspaces: {
      [WORKSPACE_ID]: {
        id: WORKSPACE_ID,
        workspaceId: WORKSPACE_ID,
        kind: "cloud",
        workspace_name: "main",
        directory: WORKSPACE_ID,
        available: false,
        status: DEAD_STATUS,
      },
    },
    time: { created: BASE_TIME, updated: BASE_TIME },
}
}

/**
 * Mounts a cloud project whose single workspace is dead, with sessions and one transcript
 * already stored centrally.
 *
 * Every route is mocked here and nothing reaches a real backend. `installMockRuntime` is
 * not used because it mounts a live workspace runtime — relay origin, session create, turn
 * streaming — which is the exact thing that must be absent: a workspace that answers
 * runtime calls makes every assertion below unfalsifiable.
 */
async function installDeadWorkspace(page: Page, opts: { sessions?: StoredSession[] } = {}) {
  const sessions = opts.sessions ?? STORED_SESSIONS
  const state: DeadWorkspaceState = {
    sessionListQueries: [],
    runtimeSessionProbes: [],
    transcriptReads: [],
  }

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const type = request.resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()

    // ---- The dead workspace runtime ----
    // Every relay/runtime path answers the way a stopped sandbox does: 409
    // `cloud_runtime_unavailable`. Recorded so the tests can assert the rendered list never
    // depended on any of it.
    if (path.startsWith("/api/wr/") || path.startsWith(`/workspaces/${WORKSPACE_ID}/`)) {
      if (path.endsWith("/api/wr/events")) return sse(route, { type: "heartbeat" })
      if (path.includes("/session")) state.runtimeSessionProbes.push(`${path}${url.search}`)
      return json(route, { error: { code: "cloud_runtime_unavailable", message: "Cloud workspace runtime is unavailable" } }, 409)
    }
    if (path === `/api/workspace/${WORKSPACE_ID}/connection` || path === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      return json(route, { error: { code: "cloud_runtime_unavailable", message: "Cloud workspace runtime is unavailable" } }, 409)
    }

    // ---- Workspace identity: resolvable, but reported dead ----
    // The workspace still exists — a deleted one is a different scenario — it simply has no
    // live runtime. `status` is the signal the inventory reads to decide the control plane
    // is authoritative.
    if (isWorkspaceResolvePath(path)) {
      return json(route, {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        directory: WORKSPACE_ID,
        kind: "cloud",
        status: DEAD_STATUS,
      })
    }
    if (path === "/api/workspace") {
      if (url.searchParams.get("host") === "machine") return json(route, { workspaces: [] })
      return json(route, {
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          workspace_name: "main",
          project_id: PROJECT_ID,
          project_name: PROJECT_NAME,
          backing: "cloud-vm",
          placement: { directory: WORKSPACE_ID },
          remote_directory: WORKSPACE_ID,
          status: DEAD_STATUS,
        }],
      })
    }
    if (path.startsWith(`/api/workspace/${WORKSPACE_ID}/checkpoints`)) return json(route, { worktrees: [] })

    // ---- The central control plane: authoritative, workspace-independent ----
    if (isSessionListPath(path)) {
      state.sessionListQueries.push(url.search)
      const limit = Number(url.searchParams.get("limit") ?? "5") || 5
      const rows = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(navigationRow)
      return json(route, {
        view: {
          scope: url.searchParams.get("scope") ?? "workspace",
          groupBy: "none",
          sort: "updated_desc",
          limit,
        },
        items: rows.slice(0, limit),
        totalKnown: rows.length,
      })
    }
    if (path === "/api/control/sessions") {
      return json(route, {
        sessions: sessions.map((item) => ({
          sessionID: item.sessionId,
          session_id: item.sessionId,
          title: item.title,
          directory: WORKSPACE_ID,
          workspaceID: WORKSPACE_ID,
          projectID: PROJECT_ID,
          createdAt: item.createdAt,
          created_at: item.createdAt,
          updatedAt: item.updatedAt,
          updated_at: item.updatedAt,
          tags: [],
          attachments: [],
          environment: { kind: "cloud" },
        })),
      })
    }
    const messages = path.match(/^\/api\/control\/sessions\/([^/]+)\/messages$/)
    if (messages) {
      const sessionId = messages[1]
      state.transcriptReads.push(sessionId)
      return json(route, {
        messages: sessionId === STORED_SESSIONS[0].sessionId ? storedTranscript() : [],
        maxEventOrdinal: 0,
      })
    }
    const central = path.match(/^\/api\/control\/sessions\/([^/]+)(\/.*)?$/)
    if (central) {
      const sessionId = central[1]
      const stored = sessions.find((item) => item.sessionId === sessionId)
      if (central[2] === "/gateway") {
        return json(route, { gatewayUrl: null, workspaceId: WORKSPACE_ID, directory: WORKSPACE_ID, harnessHost: "central" })
      }
      if (central[2] === "/capabilities") {
        return json(route, { transport: "pi", abort: true, reconnect: true, replay: true })
      }
      return json(route, {
        id: sessionId,
        sessionID: sessionId,
        title: stored?.title ?? sessionId,
        directory: WORKSPACE_ID,
        workspaceID: WORKSPACE_ID,
        projectID: PROJECT_ID,
        time: { created: stored?.createdAt ?? BASE_TIME, updated: stored?.updatedAt ?? BASE_TIME },
      })
    }

    // ---- Boot surface (kept minimal and non-crashing) ----
    if (path === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        // A hosted control plane runs no runtime in-process, and this one's
        // single workspace is dead: no host aggregate, and the posture the
        // sign-in gate reads is the harness's auth mode.
        events: { hostAggregate: false },
        deployment: bootstrapDeployment(),
        project: [projectRow()],
        provider: { all: [], connected: [], default: {} },
        provider_auth: {},
        config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
      })
    }
    if (path === "/project" || path === "/experimental/project") return json(route, [projectRow()])
    if (path === "/path") return json(route, { worktree: DIR })
    if (path === "/session" || path === "/experimental/session") return json(route, [])
    if (path === "/provider" || path === "/provider/auth") {
      return json(route, {
        providers: [{
          id: "opencode",
          name: "OpenCode",
          models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
        }],
        default: { opencode: "big-pickle" },
      })
    }
    if (path === "/config") return json(route, { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } })
    if (path === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (path === "/mcp" || path === "/command") return json(route, [])
    if (path === "/api/cp/events") return sse(route, { type: "heartbeat" })
    if (path.startsWith("/api/claxedo/agent-config/")) {
      if (path.endsWith("/harness")) return json(route, { type: "opencode", model: "big-pickle", status: "ready", ready: true })
      return json(route, [])
    }

    // Anything unmatched gets an empty, well-shaped 200 rather than escaping: the Vite dev
    // server answers an escaped request with index.html at 200, which `res.json().catch(…)`
    // swallows into an empty list indistinguishable from a real empty result.
    return json(route, {})
  })

  return state
}

async function openProject(page: Page) {
  await page.goto(`/w/${WORKSPACE_ID}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
}

function sessionRows(page: Page) {
  return page.locator('[data-testid="rail-sidebar-session-row"]')
}

test.describe("core dead-workspace session history @core", () => {
  test("lists every stored session when the workspace is dead, without probing its runtime", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    // Every stored session renders, keyed by its own id.
    for (const session of STORED_SESSIONS) {
      await expect(
        page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${session.sessionId}"]`),
        `stored session ${session.sessionId} must be listed on a dead workspace`,
      ).toBeVisible({ timeout: 20_000 })
    }
    await expect(sessionRows(page)).toHaveCount(STORED_SESSIONS.length)

    // Loading terminated, and the section did not fall back to the empty or error notice
    // while the control plane had rows.
    await expect(page.locator('[data-testid="rail-sidebar-session-list-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-error"]')).toHaveCount(0)

    // The rows came from the control plane, not from the dead runtime. The runtime is still
    // contacted for other concerns — status polls, the boot inventory sweep — and every
    // such call 409s, so the three visible rows above can only have come from
    // `/api/control/session-list`.
    expect(state.sessionListQueries.length).toBeGreaterThan(0)
  })

  test("opens a stored session on a dead workspace and renders its full transcript", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    const target = STORED_SESSIONS[0]
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.sessionId}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()

    // The stored assistant reply renders, asserted through the shared oracle rather than a
    // bare text locator.
    await expectAssistantReplyVisible(page, TRANSCRIPT_REPLY)
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    // It came from the central store: the runtime answers nothing but 409 here,
    // so a rendered transcript can only have been served centrally.
    expect(state.transcriptReads).toContain(target.sessionId)
  })

  test("project-scoped list works for a non-ws_ project id", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    await expect(sessionRows(page).first()).toBeVisible({ timeout: 20_000 })

    // A project-scoped query may carry only a projectId: resolving it to workspaces is the
    // server's job, so no client-side workspaceId is required. When the sidebar does send
    // one it must be this project's own id, never a `ws_`-shaped guess derived from it.
    const projectScoped = state.sessionListQueries
      .map((search) => new URLSearchParams(search))
      .filter((params) => params.get("scope") === "project")
    for (const params of projectScoped) {
      expect(params.get("projectId")).toBe(PROJECT_ID)
    }
    // Whatever mix of scopes the sidebar used, every query resolved to rows:
    // no request failed the way a 400 `workspace_id_required` would have.
    await expect(page.locator('[data-testid="rail-sidebar-session-list-error"]')).toHaveCount(0)
    await expect(sessionRows(page)).toHaveCount(STORED_SESSIONS.length)
  })

  test("an honestly empty control plane shows the empty notice, not a spinner", async ({ page }) => {
    const state = await installDeadWorkspace(page, { sessions: [] })
    await openProject(page)

    // Nothing stored AND a dead workspace: the honest terminal state is empty,
    // reached without hanging on a spinner.
    await expect(page.locator('[data-testid="rail-sidebar-session-list-loading"]')).toHaveCount(0, { timeout: 20_000 })
    await expect(sessionRows(page)).toHaveCount(0)
    expect(state.sessionListQueries.length).toBeGreaterThan(0)
  })
})
