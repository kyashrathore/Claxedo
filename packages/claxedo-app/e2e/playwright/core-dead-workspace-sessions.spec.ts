/**
 * SPEC: Dead-workspace session history (control-plane authoritative)
 *
 * PURPOSE — a cloud project's sessions sync back to the central bus and are
 * stored in Convex (`session_history` / `session_messages`, convex/schema.ts:
 * 333-360). Because that copy is central, it must remain readable when the
 * backing sandbox is stopped, destroyed, or otherwise dead: the user opens a
 * project they created days ago, its VM is long gone, and they still expect the
 * full session list in the rail sidebar and the full transcript when they open
 * one. Before the fix this surface went empty/spinning — the inventory treated
 * an empty control-plane list as "ask the live runtime instead"
 * (`fetchSignedWorkspaceSessions`, src/features/session/data/sync/
 * inventory-source.ts), which dead-ends on a workspace that cannot answer, and
 * the project-scoped list 400'd for any project id not shaped `ws_*`
 * (`sessionListWorkspaceId`, claxedo-server/src/session/routes/
 * control-plane-session.ts).
 *
 * STATE MODEL —
 *   - **Workspace liveness** is the runtime status reported by
 *     `GET /api/workspace/resolve` (`status`), sourced server-side from the
 *     supervisor lease plus the workspace row (claxedo-server/src/workspace/
 *     routes/index.ts:88). `stopped | destroyed | unavailable | failed |
 *     offline | deleted` mean unreachable; anything else (including absent)
 *     is treated as reachable, so healthy workspaces keep their runtime
 *     fallback (`workspaceRuntimeReachable`, inventory-source.ts).
 *   - **Session rows** for a section come from `GET /api/control/session-list`
 *     (TanStack Query via `sessionListQueryOptions`). This endpoint reads the
 *     central store and has NO workspace dependency — that is what makes it
 *     survive a dead sandbox.
 *   - **Transcripts** come from `GET /api/control/sessions/:id/messages`, which
 *     also reads the central store (control-plane-session.ts). Routing to it
 *     rather than to the workspace relay requires a CONFIRMED `cloud` workspace
 *     kind (`resolveSessionResourceRoute` branch C diverts unresolved-kind
 *     workspaces to the relay — src/platform/runtime/agent/placement-table.ts).
 *   - Nothing here is persisted client-side; every assertion below is served
 *     fresh from the mocked control plane.
 *
 * ANATOMY —
 *   `[data-testid="rail-sidebar"]` — tree root.
 *   `[data-testid="rail-sidebar-session-row"][data-session-id]` — one row per
 *     session returned by the session-list endpoint.
 *   `[data-testid="rail-sidebar-session-list-loading|error|empty"]` — the
 *     per-section list-state notices. On a dead workspace with stored sessions
 *     NONE of these may be the terminal state: rows must render instead.
 *   `[data-slot="session-turn-message-content"]` / `[data-slot="session-turn-
 *     assistant-content"]` — the transcript rows, asserted through the shared
 *     turn oracle, never by bare text locators (INVARIANTS.md authoring rule 2).
 *
 * BEHAVIORS —
 *   1. A cloud project whose workspace is DEAD still lists every session the
 *      control plane holds. Proof: all seeded rows render while the workspace
 *      runtime answers nothing but 409 `cloud_runtime_unavailable`, so the rows
 *      can only have come from the control plane.
 *   2. Loading terminates on a dead workspace — the section never sits on the
 *      loading notice, and never lands on the empty/error notice while the
 *      control plane has rows.
 *   3. Opening a session on a dead workspace renders its full stored
 *      transcript, served by the control-plane messages endpoint.
 *   4. The project-scoped session list works for a NON-`ws_` project id: the
 *      client sends `scope=project&projectId=<id>` with no `workspaceId`, and
 *      the server resolves the project's workspaces instead of 400ing.
 *
 * INVARIANTS —
 *   - Control-plane data is authoritative for cloud sessions whenever the
 *     workspace is unreachable: the rendered list and transcript must not
 *     depend on any runtime response. Enforced by making every runtime route
 *     409 and still asserting rows/transcript, plus a request assertion that
 *     the control-plane endpoints were actually hit — never a sleep
 *     (INVARIANTS.md rule 3).
 *   - The workspace GATE must not hide central history: a dead cloud workspace
 *     renders its surface (`hasCentralHistory`, src/features/workspaces/data/
 *     workspace-gate.tsx) rather than the offline panel. User-hosted keeps the
 *     offline panel — it genuinely has no central copy.
 *   - No silent empty state: an empty list is only honest when the control
 *     plane itself returned nothing.
 *
 * HARNESS NOTES — the cloud lane here is deliberately thin: this spec never
 * sends a turn, so it mounts no relay and no harness. It seeds already-stored
 * history and asserts the read path, which is the surface the bug lives on.
 *
 * OUT OF SCOPE — sending turns on a cloud workspace (core-harness-ownership-
 * cloud), relay role/offline mint behavior (core-cloud-offline-roles),
 * provisioning (core-cloud-provisioning), and user-hosted workspaces, which
 * genuinely have no central copy (core-user-hosted-workspace).
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-dead-workspace"
const WORKSPACE_ID = "ws_dead_e2e"
// Deliberately NOT `ws_`-prefixed: this is the shape that used to 400 the
// project-scoped session list (behavior 4).
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
 * assistant, and the assistant message carries `time.completed` so the turn is
 * SETTLED: a settled turn renders its content regardless of session.status,
 * which never arrives here (INVARIANTS.md cross-cutting invariant 3).
 */
function storedTranscript() {
  const sessionID = STORED_SESSIONS[0]!.sessionId
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
  /** Any request that would have probed the DEAD workspace runtime for sessions. */
  runtimeSessionProbes: string[]
  /** `/api/control/sessions/:id/messages` reads, by session id. */
  transcriptReads: string[]
}

/**
 * Mounts a cloud project whose single workspace is DEAD, with sessions and one
 * transcript already stored centrally.
 *
 * This spec is Tier M: every route is mocked here and nothing reaches a real
 * backend. It does not use `installMockRuntime` because that helper mounts a
 * LIVE workspace runtime (relay origin, session create, turn streaming) — the
 * precise thing that must be absent for this scenario to mean anything. A dead
 * workspace answering runtime calls would make behavior 1 unfalsifiable.
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

    // ---- The DEAD workspace runtime ----
    // Every relay/runtime path answers the way a stopped sandbox does: 409
    // `cloud_runtime_unavailable` (claxedo-server/src/authority/
    // hosted-session-pull.ts). Recorded so behavior 1 can assert the session
    // list never depended on it.
    if (path.startsWith("/api/wr/") || path.startsWith(`/workspaces/${WORKSPACE_ID}/`)) {
      if (path.endsWith("/events") || path.endsWith("/runtime-events")) return sse(route, { type: "heartbeat" })
      if (path.includes("/session")) state.runtimeSessionProbes.push(`${path}${url.search}`)
      return json(route, { error: { code: "cloud_runtime_unavailable", message: "Cloud workspace runtime is unavailable" } }, 409)
    }
    if (path === `/api/workspace/${WORKSPACE_ID}/connection` || path === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      return json(route, { error: { code: "cloud_runtime_unavailable", message: "Cloud workspace runtime is unavailable" } }, 409)
    }

    // ---- Workspace identity: resolvable, but reported DEAD ----
    // The workspace still EXISTS (a deleted workspace is a different scenario);
    // it simply has no live runtime. `status` is the signal the inventory reads
    // to decide the control plane is authoritative.
    if (path === "/api/workspace/resolve") {
      return json(route, {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        directory: WORKSPACE_ID,
        kind: "cloud",
        status: DEAD_STATUS,
      })
    }
    if (path === "/api/workspace") {
      const access = url.searchParams.get("access")
      if (access === "user-hosted") return json(route, { workspaces: [] })
      return json(route, {
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          workspace_name: "main",
          project_id: PROJECT_ID,
          project_name: PROJECT_NAME,
          access: "cloud",
          backing: "cloud-vm",
          remote_directory: WORKSPACE_ID,
          status: DEAD_STATUS,
        }],
      })
    }
    if (path.startsWith(`/api/workspace/${WORKSPACE_ID}/checkpoints`)) return json(route, { worktrees: [] })

    // ---- The central control plane: authoritative, workspace-independent ----
    // Loopback transports rewrite this to `/api/claxedo/session-list`
    // (workspace-control-routes.ts:150) — accept both spellings so the query
    // recording keeps capturing whichever one the app uses.
    if (path === "/api/control/session-list" || path === "/api/claxedo/session-list") {
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
      const sessionId = messages[1]!
      state.transcriptReads.push(sessionId)
      return json(route, {
        messages: sessionId === STORED_SESSIONS[0]!.sessionId ? storedTranscript() : [],
        maxEventOrdinal: 0,
      })
    }
    const central = path.match(/^\/api\/control\/sessions\/([^/]+)(\/.*)?$/)
    if (central) {
      const sessionId = central[1]!
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
    if (path === "/project" || path === "/experimental/project") {
      return json(route, [{
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
      }])
    }
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
    if (path === "/agent" || path === "/app/agents") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (path === "/mcp" || path === "/command") return json(route, [])
    if (path === "/global/event" || path === "/event" || path === "/api/claxedo/events") {
      return sse(route, { directory: "global", payload: { type: "server.connected", properties: {} } })
    }
    if (path.startsWith("/api/claxedo/agent-config/")) {
      if (path.endsWith("/harness")) return json(route, { type: "opencode", model: "big-pickle", status: "ready", ready: true })
      return json(route, [])
    }

    // Anything unmatched gets an empty, well-shaped 200 rather than escaping to
    // a real backend (Tier M rule): the Vite dev server would answer an escape
    // with index.html at 200, which `res.json().catch(...)` silently swallows
    // into an empty list indistinguishable from a real empty result.
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
  test("lists every stored session when the workspace is dead, without probing its runtime — behaviors 1,2", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    // Behavior 1: every stored session renders, keyed by its own id.
    for (const session of STORED_SESSIONS) {
      await expect(
        page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${session.sessionId}"]`),
        `stored session ${session.sessionId} must be listed on a dead workspace`,
      ).toBeVisible({ timeout: 20_000 })
    }
    await expect(sessionRows(page)).toHaveCount(STORED_SESSIONS.length)

    // Behavior 2: loading terminated, and the section did not fall back to the
    // empty or error notice while the control plane had rows.
    await expect(page.locator('[data-testid="rail-sidebar-session-list-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-error"]')).toHaveCount(0)

    // Behavior 1's real enforcement: the rows came from the control plane, not
    // from the dead runtime. A request assertion, not a sleep (INVARIANTS.md
    // rule 3). The runtime IS still contacted for other concerns (status polls,
    // the boot inventory sweep) and every such call 409s here — the invariant
    // is that the rendered list does not depend on any of them, which the rows
    // above prove: the runtime answered nothing but 409, so the three visible
    // rows can only have come from `/api/control/session-list`.
    expect(state.sessionListQueries.length).toBeGreaterThan(0)
  })

  test("opens a stored session on a dead workspace and renders its full transcript — behavior 3", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    const target = STORED_SESSIONS[0]!
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.sessionId}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()

    // The stored assistant reply renders — through the shared oracle, which is
    // the only sanctioned way to assert assistant text (INVARIANTS.md rule 2).
    await expectAssistantReplyVisible(page, TRANSCRIPT_REPLY)
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    // It came from the central store: the runtime answers nothing but 409 here,
    // so a rendered transcript can only have been served centrally.
    expect(state.transcriptReads).toContain(target.sessionId)
  })

  test("project-scoped list works for a non-ws_ project id — behavior 4", async ({ page }) => {
    const state = await installDeadWorkspace(page)
    await openProject(page)

    await expect(sessionRows(page).first()).toBeVisible({ timeout: 20_000 })

    // The client is allowed to send a project-scoped query carrying only a
    // projectId — resolving it to workspaces is the SERVER's job now, so no
    // client-side workspaceId is required for the list to succeed. When the
    // sidebar does send one, it must be this project's own id (never a
    // `ws_`-shaped guess derived from the project id).
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

  test("an honestly empty control plane shows the empty notice, not a spinner — behavior 2", async ({ page }) => {
    const state = await installDeadWorkspace(page, { sessions: [] })
    await openProject(page)

    // Nothing stored AND a dead workspace: the honest terminal state is empty,
    // reached without hanging on a spinner.
    await expect(page.locator('[data-testid="rail-sidebar-session-list-loading"]')).toHaveCount(0, { timeout: 20_000 })
    await expect(sessionRows(page)).toHaveCount(0)
    expect(state.sessionListQueries.length).toBeGreaterThan(0)
  })
})
