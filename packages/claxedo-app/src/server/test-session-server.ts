import { QueryClient } from "@tanstack/solid-query"
import { placementId, projectId, sessionId } from "./ids"
import { sessionEndpoint } from "./session-context"
import { createStatusOwner } from "./status"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { TranscriptPart } from "./types"
import { workspaceStopped } from "./wire/connection"
import { viewportQuery } from "./wire/turn-page"
import { createWorkspaces } from "./workspaces"

export const ref = { projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") }
export const shape = { rows: 40, cols: 100, reasoning: false, shell: false, edit: false }
export const firstPath = withQuery(sessionEndpoint(ref, "/outline"), viewportQuery(shape))
export const openPath = withQuery(sessionEndpoint(ref), { view: "open" })
export const liveSession = { id: "ses_1", title: "Live title", time: { created: 10, updated: 30 } }
export const centralRow = { session_id: "ses_1", title: "Ship it", created_at: 10, updated_at: 20, last_human_turn_at: 15 }
const outline = { turns: [{ id: "msg_1", createdAt: 1, user: "why?" }], complete: true }

export function firstRead(session: Readonly<Record<string, unknown>> = liveSession, page: unknown = { turns: [{ messages: stored }] }) {
  return Response.json({ session, outline, page })
}

export function openView(facts: Readonly<Record<string, unknown>> = {}) {
  return Response.json({
    status: { value: null },
    permissions: { value: [] },
    questions: { value: [] },
    todos: { value: [] },
    goal: { value: { capabilities: { implemented: false, available: false, actions: [] }, goal: null } },
    subagents: { value: [] },
    ...facts,
  })
}

export const stored = [
  { info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }, parts: [{ id: "prt_1", type: "text", text: "why?" }] },
  { info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt_2", type: "text", text: "because" }] },
]

export const storedTool: TranscriptPart = { id: "prt_3", sessionID: "ses_1", messageID: "msg_2", type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a", title: "ls", metadata: {}, time: { start: 1, end: 2 } } }

const MACHINE_ROW = { backing: "local-worktree", placement: { host_enrollment_id: "enr_laptop" } }

export function bootstrap(reachable: () => boolean, machine: boolean) {
  return {
    events: { hostAggregate: false },
    deployment: { serverKind: "daemon", issuesSessions: true },
    project: [{
      id: "proj_1",
      worktree: "ws_cloud",
      workspaces: { ws_cloud: { id: "ws_cloud", ...(machine ? MACHINE_ROW : { backing: "cloud-vm" }), reachable: reachable(), directory: "workspace:ws_cloud" } },
    }],
  }
}

type FakeServerOptions = {
  reachable: () => boolean
  machine?: boolean
  runtime?: (path: string) => Response | Promise<Response>
  requested?: (path: string) => void
  sessionHosts?: Readonly<Record<string, string>>
}

function controlPlaneAnswer(options: FakeServerOptions, path: string): Response {
  if (path === "/api/claxedo/bootstrap") return Response.json(bootstrap(options.reachable, options.machine ?? false))
  if (path.startsWith("/api/control/sessions/ses_1/page")) return Response.json({ turns: [{ messages: stored }] })
  if (path.startsWith("/api/control/sessions/ses_1/part")) return Response.json({ part: storedTool })
  if (path.startsWith("/api/control/sessions/ses_1/outline")) return firstRead(centralRow, { turns: [{ messages: stored, cursor: "cursor_older" }] })
  if (path.startsWith("/api/control/sessions?")) return Response.json({ sessions: [centralRow] })
  return Response.json({ error: { code: "unexpected", message: path } }, { status: 500 })
}

type FakeCalls = { readonly requests: string[]; readonly runtimeCalls: string[]; readonly hostedCalls: string[]; readonly hostReads: string[] }

function fakeTransport(options: FakeServerOptions, calls: FakeCalls): Transport {
  const request = async (path: string) => {
    calls.requests.push(path)
    options.requested?.(path)
    return controlPlaneAnswer(options, path)
  }
  const runtime = async (route: RuntimeRoute, path: string) => {
    calls.runtimeCalls.push(path)
    if (route.sessionHost) calls.hostedCalls.push(path)
    return options.runtime ? options.runtime(path) : Response.json({ error: { message: "unexpected runtime read" } }, { status: 500 })
  }
  const readJson = async (response: Response): Promise<unknown> => response.json()
  return {
    serverUrl: "https://cp.test",
    loopback: false,
    request,
    runtime,
    runtimeSocket: async () => {
      throw new Error("no sockets")
    },
    json: async (path: string) => readJson(await request(path)),
    runtimeJson: async (route: RuntimeRoute, path: string) => {
      const response = await runtime(route, path)
      if (response.status === 409) throw workspaceStopped("ws_cloud")
      return readJson(response)
    },
    startRuntime: async () => undefined,
    connectSession: async () => undefined,
    onSessionHost: () => () => undefined,
    findSessionHost: async (_workspaceId: string, sessionId: string) => {
      calls.hostReads.push(sessionId)
      return options.sessionHosts?.[sessionId]
    },
  }
}

export function fakeServer(options: FakeServerOptions) {
  const calls: FakeCalls = { requests: [], runtimeCalls: [], hostedCalls: [], hostReads: [] }
  const transport = fakeTransport(options, calls)
  const workspaces = createWorkspaces(transport, new QueryClient())
  return { context: { transport, workspaces, status: createStatusOwner(transport) }, ...calls }
}
