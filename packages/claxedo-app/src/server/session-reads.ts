import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { readCentralFirst, readCentralPage, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { withQuery, type RuntimeRoute } from "./transport"
import type { FirstPageShape, HeldSessionReads, SessionFirstRead, SessionReads, SessionRef, SessionStatus, TranscriptPage } from "./types"
import { GOAL_UNAVAILABLE } from "./wire/goal"
import { firstReadFromWire, NO_FIRST_PAGE, viewportQuery } from "./wire/first-read"
import { OPEN_VIEW, sessionOpenFromWire, type SessionFact, type SessionOpenView } from "./wire/session-open"
import { sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const STOPPED_STATUS: SessionStatus = { kind: "idle" }
const NO_TRANSCRIPT: TranscriptPage = { entries: [] }

function runtimeRow(session: AgentPresentationSession, ref: SessionRef): Pick<SessionFirstRead, "row" | "diff"> {
  return { row: sessionRowFromSession(session, ref), diff: session.summary?.diffs ?? [] }
}

async function readRuntimeFirst(context: SessionContext, route: RuntimeRoute, ref: SessionRef, shape: FirstPageShape): Promise<SessionFirstRead> {
  const response = await context.transport.runtime(route, withQuery(sessionEndpoint(ref, "/outline"), viewportQuery(shape)))
  if (!response.ok) throw await responseError(response, "First read")
  const read = firstReadFromWire(await response.json())
  return { ...runtimeRow(read.session as AgentPresentationSession, ref), outline: read.outline, ...(read.page ?? NO_FIRST_PAGE) }
}

async function readOfflineFirst(context: SessionContext, workspaceId: string, ref: SessionRef): Promise<SessionFirstRead> {
  return { row: await readCentralRow(context, workspaceId, ref), diff: [], outline: undefined, ...NO_FIRST_PAGE }
}

function readLiveSession(context: SessionContext, ref: SessionRef): Promise<AgentPresentationSession | undefined> {
  return onRuntime(context, ref, (route) => context.transport.runtimeJson<AgentPresentationSession>(route, sessionEndpoint(ref)), async () => undefined)
}

async function readHeldFirst(context: SessionContext, ref: SessionRef, held: HeldSessionReads): Promise<SessionFirstRead> {
  const home = await context.workspaces.home(ref)
  const live = await readLiveSession(context, ref)
  const row = live ? runtimeRow(live, ref) : { row: await readCentralRow(context, home.route.workspaceId, ref), diff: [] }
  return { ...row, outline: held.outline, transcript: held.latestTurn, folded: NO_FIRST_PAGE.folded, latestTurn: held.latestTurn }
}

async function readFirst(context: SessionContext, ref: SessionRef, shape: FirstPageShape): Promise<SessionFirstRead> {
  const home = await context.workspaces.home(ref)
  if (!home.central) {
    return onRuntime(context, ref, (route) => readRuntimeFirst(context, route, ref, shape), (workspaceId) => readOfflineFirst(context, workspaceId, ref))
  }
  const [stored, live] = await Promise.all([
    readCentralFirst(context, home.route.workspaceId, ref, shape),
    home.live ? readLiveSession(context, ref) : undefined,
  ])
  return live ? { ...stored, ...runtimeRow(live, ref) } : stored
}

function factValue<T>(fact: SessionFact<T>): T {
  if ("error" in fact) throw fact.error
  return fact.value
}

function goalOf(view: SessionOpenView) {
  return "error" in view.goal && view.goal.error.code === GOAL_UNAVAILABLE ? NO_GOAL : factValue(view.goal)
}

export function readSession(context: SessionContext, ref: SessionRef, shape: FirstPageShape, held?: HeldSessionReads): SessionReads {
  const { transport } = context
  const first = held ? readHeldFirst(context, ref, held) : readFirst(context, ref, shape)
  const opened = onRuntime<SessionOpenView | undefined>(
    context,
    ref,
    async (route) => sessionOpenFromWire(await transport.runtimeJson<unknown>(route, withQuery(sessionEndpoint(ref), OPEN_VIEW))),
    async () => undefined,
  )
  const fact = <T>(read: (view: SessionOpenView) => T, stopped: T) => opened.then((view) => (view ? read(view) : stopped))
  return {
    first,
    status: Promise.all([first, opened]).then(([read, view]) => (view ? context.status.read(ref, read.row.lastTurn, view.status) : STOPPED_STATUS)),
    requests: fact((view) => factValue(view.requests), []),
    todos: fact((view) => factValue(view.todos), []),
    goal: fact(goalOf, NO_GOAL),
    subagents: fact((view) => factValue(view.subagents), []),
  }
}

async function readRuntimeOlder(context: SessionContext, where: RuntimeRoute, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, withQuery(sessionEndpoint(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor }))
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  const home = await context.workspaces.home(ref)
  if (home.central) return readCentralPage(context, home.route.workspaceId, ref, { before: cursor })
  if (!home.live) return NO_TRANSCRIPT
  return readRuntimeOlder(context, home.route, ref, cursor)
}
