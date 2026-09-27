import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { readCentralPage, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL, readGoalState } from "./session-goal"
import { readRequests } from "./session-requests"
import { withQuery, type RuntimeRoute } from "./transport"
import type { SessionReads, SessionRef, SessionStatus, SessionSurfaceRead, Todo, TranscriptPage } from "./types"
import type { SessionHome } from "./workspaces"
import { isWorkspaceStopped } from "./wire/connection"
import { sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const STOPPED_STATUS: SessionStatus = { kind: "idle" }

export async function onRuntime<T>(
  context: SessionContext,
  ref: SessionRef,
  live: (route: RuntimeRoute) => Promise<T>,
  stopped: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (!home.live) return stopped(home.route.workspaceId)
  try {
    return await live(home.route)
  } catch (error) {
    if (!isWorkspaceStopped(error)) throw error
    await context.workspaces.refresh()
    if ((await context.workspaces.home(ref)).live) throw error
    return stopped(home.route.workspaceId)
  }
}

async function readPage(context: SessionContext, where: RuntimeRoute, path: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

const NO_TRANSCRIPT: TranscriptPage = { entries: [] }

function readHistory(context: SessionContext, ref: SessionRef, home: SessionHome, before?: string): Promise<TranscriptPage> {
  if (home.central) return readCentralPage(context, home.route.workspaceId, ref, before === undefined ? { view: "latest-surface" } : { before })
  if (!home.live) return Promise.resolve(NO_TRANSCRIPT)
  const page = before === undefined ? { view: "latest-surface" } : { limit: OLDER_PAGE_SIZE, before }
  return readPage(context, home.route, withQuery(sessionEndpoint(ref, "/message"), page))
}

async function readSurface(context: SessionContext, ref: SessionRef, session: Promise<AgentPresentationSession | undefined>): Promise<SessionSurfaceRead> {
  const home = context.workspaces.home(ref)
  const [transcript, details] = await Promise.all([
    home.then((home) => readHistory(context, ref, home)),
    Promise.all([home, session]).then(async ([home, row]) => ({
      row: row ? sessionRowFromSession(row, ref) : await readCentralRow(context, home.route.workspaceId, ref),
      diff: row?.summary?.diffs ?? [],
    })),
  ])
  return { ...details, transcript }
}

export function readSession(context: SessionContext, ref: SessionRef): SessionReads {
  const { transport } = context
  const live = <T>(read: (route: RuntimeRoute) => Promise<T>, stopped: T) => onRuntime(context, ref, read, async () => stopped)
  const session = live<AgentPresentationSession | undefined>((route) => transport.runtimeJson<AgentPresentationSession>(route, sessionEndpoint(ref)), undefined)
  return {
    surface: readSurface(context, ref, session),
    status: live(async (route) => {
      const row = await session
      return row ? context.status.read(route, ref, row) : STOPPED_STATUS
    }, STOPPED_STATUS),
    requests: live(async (route) => (await readRequests(transport, route, ref.sessionId)).map((item) => item.request), []),
    todos: live((route) => transport.runtimeJson<readonly Todo[]>(route, sessionEndpoint(ref, "/todo")), []),
    goal: live((route) => readGoalState(transport, route, ref), NO_GOAL),
  }
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  return readHistory(context, ref, await context.workspaces.home(ref), cursor)
}
