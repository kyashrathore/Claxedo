import { NO_BACKGROUND_WORK, type AgentSession } from "@claxedo/agent-runtime-contract"
import { readField } from "@claxedo/helpers/readers"
import { readCentralFirst, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { withQuery, type RuntimeRoute } from "./transport"
import type { SessionStatus } from "./status-types"
import type { HeldSessionReads, PageShape, SessionFirstRead, SessionReads, SessionLocation } from "./types"
import { GOAL_UNAVAILABLE } from "./wire/goal"
import { firstReadFromWire, NO_FIRST_PAGE } from "./wire/first-read"
import { OPEN_VIEW, sessionOpenFromWire, TODOS_UNSUPPORTED, type SessionFact, type SessionOpenView } from "./wire/session-open"
import { fileDiffsFromWire } from "./wire/file-diffs"
import { sessionFromWire, sessionRowFromSession } from "./wire/session-row"
import { viewportQuery } from "./wire/turn-page"

const STOPPED_STATUS: SessionStatus = { kind: "idle" }

function runtimeRow(session: AgentSession, ref: SessionLocation): Pick<SessionFirstRead, "row" | "diff"> {
  return { row: sessionRowFromSession(session, ref), diff: fileDiffsFromWire(readField(readField(session, "summary"), "diffs")) ?? [] }
}

async function readRuntimeFirst(context: SessionContext, route: RuntimeRoute, ref: SessionLocation, shape: PageShape): Promise<SessionFirstRead> {
  const response = await context.transport.runtime(route, withQuery(sessionEndpoint(ref, "/outline"), viewportQuery(shape)))
  if (!response.ok) throw await responseError(response, "First read")
  const read = firstReadFromWire(await response.json())
  return { ...runtimeRow(sessionFromWire(read.session), ref), outline: read.outline, ...(read.page ?? NO_FIRST_PAGE) }
}

async function readOfflineFirst(context: SessionContext, workspaceId: string, ref: SessionLocation): Promise<SessionFirstRead> {
  return { row: await readCentralRow(context, workspaceId, ref), diff: [], outline: undefined, ...NO_FIRST_PAGE }
}

function readLiveSession(context: SessionContext, ref: SessionLocation): Promise<AgentSession | undefined> {
  return onRuntime(context, ref, async (route) => sessionFromWire(await context.transport.runtimeJson(route, sessionEndpoint(ref))), async () => undefined)
}

async function readHeldFirst(context: SessionContext, ref: SessionLocation, held: HeldSessionReads): Promise<SessionFirstRead> {
  const home = await context.workspaces.home(ref)
  const live = await readLiveSession(context, ref)
  const row = live ? runtimeRow(live, ref) : { row: await readCentralRow(context, home.route.workspaceId, ref), diff: [] }
  return { ...row, outline: held.outline, transcript: held.latestTurn, latestTurn: held.latestTurn }
}

async function readFirst(context: SessionContext, ref: SessionLocation, shape: PageShape): Promise<SessionFirstRead> {
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

function todosOf(view: SessionOpenView) {
  return "error" in view.todos && view.todos.error.code === TODOS_UNSUPPORTED ? [] : factValue(view.todos)
}

export function startSessionReads(context: SessionContext, ref: SessionLocation, shape: PageShape, held?: HeldSessionReads): SessionReads {
  const { transport } = context
  const first = held ? readHeldFirst(context, ref, held) : readFirst(context, ref, shape)
  const opened = onRuntime<SessionOpenView | undefined>(
    context,
    ref,
    async (route) => sessionOpenFromWire(await transport.runtimeJson(route, withQuery(sessionEndpoint(ref), OPEN_VIEW))),
    async () => undefined,
  )
  const fact = <T>(read: (view: SessionOpenView) => T, stopped: T) => opened.then((view) => (view ? read(view) : stopped))
  return {
    first,
    status: Promise.all([first, opened]).then(([read, view]) => (view ? context.status.read(ref, read.row.lastTurn, view.status) : STOPPED_STATUS)),
    backgroundWork: fact((view) => factValue(view.backgroundWork), NO_BACKGROUND_WORK),
    requests: fact((view) => factValue(view.requests), []),
    todos: fact(todosOf, []),
    goal: fact(goalOf, NO_GOAL),
    subagents: fact((view) => factValue(view.subagents), []),
  }
}
