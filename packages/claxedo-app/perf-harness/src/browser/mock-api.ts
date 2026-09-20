import type { EnvironmentProfile } from "../environment-profile"
import {
  MockMessagePageError,
  selectMockMessagePage,
  parseMockMessagePageRequest,
  projectMockSurfacePage,
} from "../mock-message-page"
import { stabilityRequestClass } from "./scenarios/session-switch-workspace-contract"
import type { BrowserTarget } from "./environment"
import {
  type fixtureFor,
  changedFilesForVcs,
  fileContent,
  workspaceLabel,
  perfMessageID,
  perfMessageIndex,
  perfMessageRole,
  message,
} from "./fixtures"
import type { monitorPage } from "./page-validation"
import { workspaceFileResourcePath } from "./workspace-file-path"
import { MOCK_STREAM_FIXTURE_HEADER, mockStreamKind } from "./mock-streams"
import { appendFileSync } from "node:fs"
import path from "node:path"
import type { Page, Route } from "playwright-core"

// Sentinel for paths responseFor does not recognize. Unmatched paths answer
// 404 (loudly — they land in monitor.failedResponses + unmatchedMockPaths)
// instead of a silent 200 `{}`, so mock drift fails visibly instead of
// blanking the app with well-formed nonsense.
const UNMATCHED_MOCK_PATH = Symbol("perf.unmatched-mock-path")

const warnedUnmatchedPaths = new Set<string>()

// Request-timeline lane: CLAXEDO_PERF_REQUEST_LOG=<path> appends one JSONL row
// per mocked API request (wall-clock ms, method, path+query, status) plus a
// `boot` marker per page, so serial waterfalls / duplicate fetches / 404
// storms can be diffed across runs. Off (and zero-cost) unless the env is set.
const requestLogPath = process.env.CLAXEDO_PERF_REQUEST_LOG

let requestLogBootSeq = 0

function logMockRequest(row: Record<string, unknown>) {
  if (!requestLogPath) return
  appendFileSync(requestLogPath, `${JSON.stringify(row)}\n`)
}

export async function installMockApi(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
  monitor: ReturnType<typeof monitorPage>,
  profile: EnvironmentProfile,
) {
  const streamLease = app.streams.registerFixture({
    origin: app.baseUrl,
    directories: fixture.workspaceDirectories,
    sessionIds: fixture.sessions.map((session) => session.id),
  })
  page.on("close", streamLease.close)
  page.on("crash", streamLease.close)
  const bootSeq = ++requestLogBootSeq
  const bootStarted = Date.now()
  logMockRequest({ boot: bootSeq, at: bootStarted })
  // CLAXEDO_PERF_FETCH_STACKS=1 (needs CLAXEDO_PERF_REQUEST_LOG too): wrap
  // window.fetch in the page and append the JS initiator stack of each API
  // request to the request log, so duplicate fetches can be attributed to
  // their call sites (minified frames still identify distinct callers).
  if (requestLogPath && process.env.CLAXEDO_PERF_FETCH_STACKS === "1") {
    page.on("console", (message) => {
      if (!message.text().startsWith("[FETCH_STACK]")) return
      logMockRequest({ boot: bootSeq, t: Date.now() - bootStarted, stack: message.text().slice("[FETCH_STACK]".length) })
    })
    await page.addInitScript(() => {
      const original = globalThis.fetch
      const logging = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        try {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (/workspace\/resolve|\/provider|\/api\/claxedo\/session|\/vcs|permission-mode|\/meta(?:\?|$)|\/session\/[^/]+\/config/.test(url)) {
            console.debug(`[FETCH_STACK]${url} :: ${new Error("stack").stack?.split("\n").slice(2, 8).join(" | ")}`)
          }
        } catch {}
        return original.call(this, input, init)
      }
      // The rest of `fetch` is carried over rather than dropped: the assertion
      // this replaced installed a bare function, so anything on the original
      // (`preconnect`) stopped existing once the harness wrapped it.
      globalThis.fetch = Object.assign(logging, { preconnect: original.preconnect })
    })
  }
  await page.routeWebSocket(/\/api\/wr\/pty\/[^/]+\/connect(?:\?|$)/, (socket) => {
    socket.send("perf terminal ready\r\n")
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const logRow = (status: number, note?: string) => logMockRequest({
      boot: bootSeq,
      t: Date.now() - bootStarted,
      method: route.request().method(),
      path: `${url.pathname}${url.search}`,
      status,
      ...(note ? { note } : {}),
    })
    if (
      process.env.PERF_DEBUG_ERRORS &&
      (url.pathname.includes("session") || url.pathname.includes("workspace"))
    ) {
      console.error(`[PERF_ROUTE] ${route.request().method()} ${url.toString()} mock=${String(shouldMock(url, app))}`)
    }
    if (!shouldMock(url, app)) return route.fallback()
    // Stability accounting for session-switch gates (CORS preflights are
    // transport, not app requests, and stay uncounted).
    if (route.request().method() !== "OPTIONS") {
      const stability = stabilityRequestClass(url.pathname)
      if (stability) fixture.requestCounts.stability[stability] += 1
    }
    // CDP network emulation cannot slow a route we fulfil in-process, so the
    // profile's round trip is added here instead. Without it a "throttled" run
    // still answers every API call in microseconds, which would make the
    // data-dependent flows look faster under emulation than the asset-bound
    // ones — the opposite of the truth. SSE streams are exempt: they are held
    // open deliberately, and delaying the open would just shift the stream
    // start, not model latency on its events.
    if (profile.mockLatencyMs > 0 && !mockStreamKind(url.pathname)) {
      await Bun.sleep(profile.mockLatencyMs)
    }
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: mockCorsHeaders(route),
      })
    }
    if (mockStreamKind(url.pathname)) {
      logRow(200, "persistent SSE")
      // Continue to a real streaming response: route.fulfill would close the
      // connection and make the client manufacture background reconnect work.
      return route.continue({
        url: `${app.streams.origin}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), [MOCK_STREAM_FIXTURE_HEADER]: streamLease.id },
      })
    }
    let body: unknown
    try {
      body = responseFor(url, fixture, route.request().method())
    } catch (error) {
      // A producer-status rejection is part of the contract the mock serves
      // (a client that combines `view` with `limit` must see the 400 the
      // product servers send), so it is answered, not thrown through the route.
      if (!(error instanceof MockMessagePageError)) throw error
      logRow(error.status, error.message)
      return route.fulfill({
        status: error.status,
        contentType: "application/json",
        headers: mockCorsHeaders(route),
        body: JSON.stringify({ error: error.message }),
      })
    }
    if (body === undefined) {
      logRow(0, "fallback")
      return route.fallback()
    }
    if (body === UNMATCHED_MOCK_PATH) {
      logRow(404, "unmatched")
      const key = `${route.request().method()} ${url.pathname}`
      if (!monitor.unmatchedMockPaths.includes(key)) monitor.unmatchedMockPaths.push(key)
      if (process.env.PERF_DEBUG_ERRORS || !warnedUnmatchedPaths.has(key)) {
        warnedUnmatchedPaths.add(key)
        console.warn(`[perf-mock] unmatched API path: ${key}`)
      }
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: mockCorsHeaders(route),
        body: JSON.stringify({ error: "perf-harness mock: unmatched path", path: url.pathname }),
      })
    }
    logRow(200)
    const envelope = body instanceof MockJsonResponse ? body : undefined
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { ...mockCorsHeaders(route), ...envelope?.headers },
      body: JSON.stringify(envelope ? envelope.body : body),
    })
  })
}

/**
 * A mock response that carries headers as well as a body. Routes return plain
 * JSON values by default; this is for the ones whose contract is partly IN the
 * response headers (the transcript page's `X-Next-Cursor`).
 */
class MockJsonResponse {
  constructor(
    readonly body: unknown,
    readonly headers: Record<string, string>,
  ) {}
}

function mockCorsHeaders(route: Route) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization, content-type",
    "access-control-expose-headers": "x-next-cursor, x-max-event-ordinal",
  }
}

function shouldMock(url: URL, app: BrowserTarget) {
  if (url.port === String(app.mockPort)) return true
  if (url.origin === app.baseUrl && (apiPath(url.pathname) || mockStreamKind(url.pathname))) return true
  if (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.origin !== app.baseUrl &&
    (apiPath(url.pathname) || mockStreamKind(url.pathname))
  ) return true
  return false
}

function apiPath(pathName: string) {
  return [
    "/agent",
    "/api",
    "/auth",
    "/command",
    "/config",
    "/experimental",
    "/file",
    "/find",
    "/formatter",
    "/global",
    "/mcp",
    "/path",
    "/permission",
    "/project",
    "/provider",
    "/pty",
    "/question",
    "/session",
    "/skill",
    "/vcs",
    "/worktree",
  ].some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`))
}

function responseFor(url: URL, fixture: ReturnType<typeof fixtureFor>, method = "GET"): unknown {
  const pathName = url.pathname
  if (pathName === "/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/global/health") return { healthy: true, version: "perf-browser" }
  if (pathName === "/experimental/session") return experimentalSessions(url, fixture)
  if (pathName === "/api/control/session-list") return sessionNavigationPage(url, fixture)
  // Loopback rewrite of the SAME navigation contract: on a loopback server
  // `sessionNavigationListUrl` (workspace-control-routes.ts:145-153) rewrites
  // `/api/control/session-list` to `/api/claxedo/session-list`, served by the
  // desktop-local product (claxedo-local-server meta-routes.ts:153) from the
  // shared `buildSessionListResponse` producer — one fixture builder for both.
  if (pathName === "/api/claxedo/session-list") return sessionNavigationPage(url, fixture)
  if (pathName === "/api/workspace") return { workspaces: controlWorkspaces(fixture) }
  if (pathName === "/api/workspace/resolve") return resolvedWorkspace(url, fixture)
  // Loopback rewrite of workspace resolve (`workspaceResolveUrl`,
  // workspace-control-routes.ts:39-42) — identical response shape.
  if (pathName === "/api/claxedo/workspace/resolve") return resolvedWorkspace(url, fixture)
  if (pathName === "/api/control/sessions") return { sessions: controlSessions(fixture, url.searchParams.get("workspaceId")) }
  // The desktop-local flat session inventory (claxedo-local-server
  // meta-routes.ts:140-152, `GET /api/claxedo/session` → `{ sessions:
  // SessionMeta[] }`), read by `fetchLocalControlSessions`
  // (features/session/data/sync/inventory-source.ts:527-535) on loopback
  // transport and mapped through `controlMetaToGlobalSession`.
  if (pathName === "/api/claxedo/session") {
    return { sessions: localSessionMetas(fixture, url.searchParams.get("directory")) }
  }
  // Usage outbox sync (features/usage/data/usage-api.ts `syncUsageOutbox`),
  // fired on boot by `installUsageOutboxWakeups`. Contract: the four counters.
  if (pathName === "/api/claxedo/usage/sync") {
    return { attempted: 0, delivered: 0, conflicts: 0, pending: 0 }
  }
  // Sanitized generic agent-connection discovery.
  if (pathName === "/api/claxedo/agent-config/connections" && method === "GET") return { status: "supported", connections: [] }
  // Remote-access device inventory is independent of local workspace/session
  // inventory. This isolated fixture has no enrolled remote devices.
  if (pathName === "/api/claxedo/remote-access/devices" && method === "GET") return { devices: [] }
  // Subagent hydration (directory-scope.tsx ensureSubagents) — HostSubagentRow[].
  if (/^\/session\/[^/]+\/subagents$/.test(pathName)) return []
  if (pathName === "/api/claxedo/diff/vcs" || pathName === "/api/wr/diff/vcs") {
    return changedFilesForVcs(url, fixture)
  }
  if (pathName === "/api/claxedo/diff/vcs/file" || pathName === "/api/wr/diff/vcs/file") {
    return diffForFile(url, fixture)
  }
  if (pathName === "/api/claxedo/diff/refs" || pathName === "/api/wr/diff/refs") {
    return {
      branches: ["dev"],
      tags: [],
      recent: [{ hash: "perf001", subject: "perf fixture" }],
    }
  }
  if (pathName === "/api/claxedo/diff/targets" || pathName === "/api/wr/diff/targets") {
    return { defaultRef: "dev", candidates: ["dev", "HEAD~1"] }
  }
  if (pathName === "/api/claxedo/hook/terminal-session") return terminalSessionPreview(url, fixture)
  if (pathName === "/api/wr/hook/terminal-session") return terminalSessionPreview(url, fixture)
  if (pathName === "/api/claxedo/pty") return fixture.terminals[0]
  if (pathName.startsWith("/api/claxedo/pty/")) return fixture.terminals[0] ?? {}
  if (pathName === "/api/claxedo/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/api/claxedo/bootstrap") return boot(fixture)
  if (pathName === "/api/claxedo/agent-config/agents") return agents()
  if (pathName === "/api/claxedo/agent-config/commands") return commands()
  // Harness status + options (the composer's harness/model controls poll
  // these on every mount). CONTRACT: the real switch POST answers `{ ok: true }`
  // and nothing else; the GET reports the active harness (mock-runtime.ts
  // serves the same pair, validated against the claxedo-server handler).
  if (pathName === "/api/claxedo/agent-config/harness") {
    return method === "POST" ? { ok: true } : { type: "opencode", ok: true }
  }
  if (pathName === "/api/claxedo/agent-config/harness/options") return harnessOptions(fixture)
  // Directory and session composers consume the same runtime-reported mode
  // contract. Keep this fixture aligned with the e2e mock's opencode report.
  if (pathName === "/permission/modes") return permissionModeReport()
  if (/^\/session\/[^/]+\/permission-mode$/.test(pathName)) return permissionModeReport()
  // Session meta for the workbench route bridge (route-bridge-resolution.ts)
  // — resolves a bare `/s/:id` route to its owning directory.
  const sessionMeta = pathName.match(/^\/api\/claxedo\/session\/([^/]+)\/meta$/)
  if (sessionMeta) {
    const session = fixture.sessions.find((item) => item.id === sessionMeta[1])
    if (!session) return UNMATCHED_MOCK_PATH
    return { directory: session.directory, title: session.title }
  }
  // Managed process inventory (features/processes/data/client.ts `list`,
  // zod-parsed as ProcessListResponse — both arrays are required).
  if (pathName === "/api/wr/process") return { configs: [], processes: [] }
  // Lifecycle checkpoints (workspace-panel). Empty is the steady state for a
  // fresh workspace; the e2e mock serves the same shape.
  if (/^\/api\/workspace\/[^/]+\/checkpoints$/.test(pathName)) return { worktrees: [] }
  // PTY metadata updates (title/size) — echo the addressed terminal.
  const wrPty = pathName.match(/^\/api\/wr\/pty(?:\/([^/]+))?$/)
  if (wrPty) {
    if (!wrPty[1]) return fixture.terminals[0]
    const terminal = fixture.terminals.find((item) => item.id === wrPty[1])
    return terminal ?? UNMATCHED_MOCK_PATH
  }
  if (pathName === "/provider") return fixture.provider
  if (pathName === "/provider/auth") return {}
  if (pathName === "/path") return fixture.path
  if (pathName === "/project") return fixture.projects
  if (pathName === "/project/current") return fixture.project
  // Project row updates (SDK `project.update`, e.g. expansion/recency touches)
  // — echo the fixture's project row, the SDK's declared response shape.
  const project = pathName.match(/^\/project\/([^/]+)$/)
  if (project) {
    if (project[1] !== fixture.project.id) return UNMATCHED_MOCK_PATH
    return fixture.project
  }
  if (pathName === "/worktree") return fixture.workspaceDirectories.slice(1)
  if (pathName === "/config") return {}
  if (pathName === "/agent") return agents()
  if (pathName === "/command") return commands()
  if (pathName === "/vcs") return { branch: "dev", default_branch: "dev" }
  if (pathName === "/vcs/status") return { branch: "dev", changed: fixture.changedFiles.slice(0, 50) }
  if (pathName === "/vcs/diff") return fixture.changedFiles
  if (pathName === "/session/status") return Object.fromEntries(fixture.sessions.map((session) => [session.id, { type: "idle" }]))
  if (pathName === "/session") return sessionsForDirectory(fixture, url.searchParams.get("directory"))
  if (["/skill", "/formatter", "/permission", "/question", "/mcp"].includes(pathName)) return []
  const fileResource = workspaceFileResourcePath(pathName)
  if (fileResource && method === "GET") {
    if (fileResource === "/file/status") return fixture.changedFiles.map((item) => ({
      path: item.file,
      added: item.additions,
      removed: item.deletions,
      status: item.status,
    }))
    if (fileResource === "/file/content") return fileContent(url, fixture)
    if (fileResource === "/find/file") return searchFiles(url, fixture)
    if (fileResource === "/file") return fileNodes(url, fixture)
    if (fileResource === "/file/all") return { paths: fixture.changedFiles.map((item) => item.file) }
  }
  if (pathName === "/pty") return fixture.terminals[0]
  if (pathName.startsWith("/pty")) return fixture.terminals[0] ?? {}

  const session = pathName.match(/^\/session\/([^/]+)$/)
  if (session) return fixture.sessions.find((item) => item.id === session[1]) ?? {}
  const sessionConfig = pathName.match(/^\/session\/([^/]+)\/config$/)
  if (sessionConfig) return configForSession(sessionConfig[1], fixture)
  const goalState = pathName.match(/^\/session\/([^/]+)\/goal\/state$/)
  if (goalState && method === "GET") {
    return fixture.sessions.some((session) => session.id === goalState[1]) ? fixture.goalState : UNMATCHED_MOCK_PATH
  }
  if (/^\/session\/[^/]+\/diff$/.test(pathName)) return fixture.changedFiles
  if (/^\/session\/[^/]+\/(children|todo)$/.test(pathName)) return []
  if (/^\/session\/[^/]+\/subagents$/.test(pathName)) return []
  if (/^\/session\/[^/]+\/capabilities$/.test(pathName)) return capabilities()

  const messages = pathName.match(/^\/session\/([^/]+)\/message$/)
  if (messages) {
    fixture.requestCounts.messages += 1
    fixture.requestCounts.messagesBySession[messages[1]] = (fixture.requestCounts.messagesBySession[messages[1]] ?? 0) + 1
    return sessionMessagePage(messages[1], url, fixture)
  }

  return UNMATCHED_MOCK_PATH
}

function sessionNavigationPage(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const scope = url.searchParams.get("scope") === "workspace"
    ? "workspace"
    : url.searchParams.get("scope") === "global"
      ? "global"
      : "project"
  const directory = url.searchParams.get("directory")
  const sessions = directory ? sessionsForDirectory(fixture, directory) : fixture.sessions
  const items = sessions.map((session) => {
    return {
      type: "session",
      sessionRef: `local:${session.directory}:session:${session.id}`,
      sessionId: session.id,
      title: session.title,
      directory: session.directory,
      projectId: session.projectID,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      tags: [],
      attachments: [],
    }
  })
  return {
    view: {
      scope,
      groupBy: "none",
      sort: "updated_desc",
      limit: Number(url.searchParams.get("limit") ?? items.length),
    },
    items,
    totalKnown: items.length,
  }
}

function resolvedWorkspace(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const requestedDirectory = url.searchParams.get("directory")
  const requestedId = url.searchParams.get("workspaceId")
  const indexFromId = requestedId?.match(/^workspace_(\d+)$/)?.[1]
  const index = requestedDirectory
    ? Math.max(0, fixture.workspaceDirectories.indexOf(requestedDirectory))
    : indexFromId
      ? Number(indexFromId)
      : 0
  return {
    workspaceId: `workspace_${String(index)}`,
    directory: fixture.workspaceDirectories[index] ?? fixture.directory,
    kind: "local",
    status: "ready",
  }
}

function diffForFile(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const file = url.searchParams.get("file")
  return fixture.changedFiles.find((item) => item.file === file) ?? fixture.changedFiles[0]
}

function searchFiles(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const query = (url.searchParams.get("query") ?? "").toLowerCase()
  return fixture.changedFiles
    .map((item) => item.file)
    .filter((file) => !query || file.toLowerCase().includes(query))
    .slice(0, Number(url.searchParams.get("limit") ?? 80))
}

function fileNodes(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const requested = normalizeFileTreePath(url.searchParams.get("path") ?? "")
  const files = fixture.changedFiles.map((item) => item.file)
  const children = new Map<string, { path: string; type: "file" | "directory" }>()
  for (const file of files) {
    const parts = file.split("/")
    const current = requested ? requested.split("/").filter(Boolean) : []
    if (current.some((part, index) => parts[index] !== part)) continue
    const next = parts[current.length]
    if (!next) continue
    const nextPath = [...current, next].join("/")
    children.set(nextPath, { path: nextPath, type: current.length === parts.length - 1 ? "file" : "directory" })
  }
  return [...children.values()].map((node) => ({
    type: node.type,
    path: node.path,
    name: path.basename(node.path),
    absolute: path.join(url.searchParams.get("directory") ?? fixture.directory, node.path),
    ignored: false,
  }))
}

function normalizeFileTreePath(value: string) {
  if (!value || value === "/") return ""
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  const generatedIndex = normalized.indexOf("src/generated")
  if (generatedIndex !== -1) return normalized.slice(generatedIndex)
  const srcIndex = normalized.indexOf("src")
  if (srcIndex !== -1) return normalized.slice(srcIndex)
  return normalized.replace(/^\/+/, "")
}

function terminalSessionPreview(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const terminalId = url.searchParams.get("terminalId") ?? fixture.terminals[0]?.id ?? "pty_perf"
  return {
    success: true,
    terminalId,
    session: {
      terminalId,
      sessionId: fixture.sessions[0]?.id ?? null,
      workspaceId: fixture.directory,
      provider: "opencode",
      refName: "dev",
      prompt: "perf terminal",
      lastAssistantMessage: "Terminal benchmark session ready",
      eventType: "ready",
      updatedAt: 1_700_000_020_000,
    },
  }
}

function experimentalSessions(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const directory = url.searchParams.get("directory")
  if (url.searchParams.get("groupBy") === "workspace") {
    return {
      groups: fixture.workspaceDirectories.map((dir) => {
        const sessions = sessionsForDirectory(fixture, dir)
        return {
          directory: dir,
          projectID: fixture.project.id,
          sessions,
          hasMore: false,
          total: sessions.length,
          nextCursor: undefined,
        }
      }),
    }
  }
  return sessionsForDirectory(fixture, directory)
}

function sessionsForDirectory(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
  if (!directory) return fixture.sessions
  return fixture.sessions.filter((session) => session.directory === directory)
}

function controlWorkspaces(fixture: ReturnType<typeof fixtureFor>) {
  return fixture.workspaceDirectories.map((directory, index) => ({
    id: `workspace_${index}`,
    workspace_id: `workspace_${index}`,
    project_id: fixture.project.id,
    worktree: directory,
    directory,
    name: workspaceLabel(fixture, directory),
    workspace_name: workspaceLabel(fixture, directory),
    access: "local",
    backing: "local",
    created_at: 1_700_000_000_000 + index,
    updated_at: 1_700_000_010_000 + index,
  }))
}

// SessionMeta rows for the desktop-local `GET /api/claxedo/session` inventory
// (claxedo-server-core session/meta/types.ts `SessionMeta`): camelCase times,
// `sessionID`, and required `tags`/`attachments`, filtered by `?directory=`
// exactly like the real handler's `listSessionMetas({ directory })`.
function localSessionMetas(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
  return sessionsForDirectory(fixture, directory).map((session) => ({
    sessionRef: `local:${session.directory}:session:${session.id}`,
    sessionID: session.id,
    host: "central",
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    tags: [],
    attachments: [],
  }))
}

function controlSessions(fixture: ReturnType<typeof fixtureFor>, workspaceId?: string | null) {
  const index = workspaceId ? Number(workspaceId.replace(/^workspace_/, "")) : NaN
  const directory = Number.isFinite(index) ? fixture.workspaceDirectories[index] : undefined
  return controlSessionRows(fixture, directory)
}

function controlSessionRows(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
  return sessionsForDirectory(fixture, directory).map((session) => ({
    id: session.id,
    sessionID: session.id,
    session_id: session.id,
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    created_at: session.time.created,
    updated_at: session.time.updated,
  }))
}

function boot(fixture: ReturnType<typeof fixtureFor>) {
  return {
    healthy: true,
    version: "perf-browser",
    // The harness models the desktop daemon: every runtime is in-process
    // behind this one origin, and it has no accounts. Omitting either
    // declaration makes the app resolve an error before its first render and
    // measures a boot no deployment performs.
    events: { hostAggregate: true },
    deployment: { issuesSessions: false },
    path: fixture.path,
    project: fixture.projects,
    provider: fixture.provider,
    provider_auth: {},
    config: {},
  }
}

function capabilities() {
  return {
    transport: "perf-browser",
    abort: true,
    reconnect: true,
    replay: true,
    permissions: true,
    questions: true,
    todos: true,
    fork: true,
    revert: true,
  }
}

function configForSession(sessionID: string, fixture: ReturnType<typeof fixtureFor>) {
  const session = fixture.sessions.find((item) => item.id === sessionID)
  return {
    runner: { type: "opencode" },
    agent: "build",
    model: {
      providerID: "opencode",
      modelID: "claude-opus-4-6",
    },
    variant: null,
    ...(session ? { directory: session.directory } : {}),
  }
}

/**
 * `GET /session/:id/message`, answered under the product's page contract
 * (see mock-message-page.ts): `view=latest-surface` is a bounded first-paint
 * fragment plus the cursor that restores what it omitted, `view=latest-turn`
 * is the complete latest turn, and `limit`/`before` walk older history.
 */
function sessionMessagePage(sessionID: string, url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const selection = selectMockMessagePage({
    request: parseMockMessagePageRequest(url.searchParams),
    total: fixture.totalMessages,
    messageID: perfMessageID,
    indexOfMessageID: perfMessageIndex,
    role: perfMessageRole,
  })
  const sessionTitle = fixture.sessions.find((session) => session.id === sessionID)?.title
  const rows = selection.indexes.map((index) =>
    message(sessionID, index, fixture.directory, sessionTitle, fixture.sessionRenderer)
  )
  const items = selection.surface ? projectMockSurfacePage(rows) : rows
  return new MockJsonResponse(items, {
    "x-max-event-ordinal": String(fixture.maxEventOrdinal),
    ...(selection.cursor ? { "x-next-cursor": selection.cursor } : {}),
  })
}

function commands() {
  return [
    { id: "terminal.new", title: "New terminal", category: "terminal" },
    { id: "review.toggle", title: "Toggle review", category: "view" },
    { id: "theme.toggle", title: "Toggle theme", category: "view" },
  ]
}

function agents() {
  return [{ name: "build", mode: "primary" }]
}

// The opencode harness's permission-mode report (HarnessModeReport,
// src/features/session/permission/modes.ts:403). opencode enforces no modes
// of its own, so the contract answer is an EMPTY modes list plus the
// `unsupported` reason — the same row the e2e mock's MODES_BY_HARNESS table
// records for opencode. `modes` must always be an array: readers dereference
// `report?.modes.length` during the composer's render, and a 200 body without
// it throws into the app-level ErrorBoundary.
function permissionModeReport() {
  return {
    modes: [],
    unsupported: "opencode has no permission modes of its own",
    appliesFrom: "next-turn",
  }
}

// Harness options for the composer's model control (same shape the e2e mock
// serves): one `model` select whose current value matches the fixture's
// provider/model pair so the composer never renders a missing-model state.
function harnessOptions(fixture: ReturnType<typeof fixtureFor>) {
  const provider = fixture.provider.all[0]
  const model = Object.values(provider.models)[0]
  return {
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
  }
}
