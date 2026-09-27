import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { readCentralPage, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { readOutline } from "./session-outline"
import { withQuery, type RuntimeRoute } from "./transport"
import type { HeldSessionReads, SessionReads, SessionRef, SessionStatus, SessionSurfaceRead, TranscriptPage } from "./types"
import type { SessionHome } from "./workspaces"
import { GOAL_UNAVAILABLE } from "./wire/goal"
import { OPEN_VIEW, sessionOpenFromWire, type SessionFact, type SessionOpenView } from "./wire/session-open"
import { sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const STOPPED_STATUS: SessionStatus = { kind: "idle" }

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

async function readSurface(context: SessionContext, ref: SessionRef, session: Promise<AgentPresentationSession | undefined>, latestTurn?: TranscriptPage): Promise<SessionSurfaceRead> {
  const home = context.workspaces.home(ref)
  const [transcript, details] = await Promise.all([
    latestTurn ?? home.then((home) => readHistory(context, ref, home)),
    Promise.all([home, session]).then(async ([home, row]) => ({
      row: row ? sessionRowFromSession(row, ref) : await readCentralRow(context, home.route.workspaceId, ref),
      diff: row?.summary?.diffs ?? [],
    })),
  ])
  return { ...details, transcript, latestTurnComplete: latestTurn !== undefined }
}

function factValue<T>(fact: SessionFact<T>): T {
  if ("error" in fact) throw fact.error
  return fact.value
}

function goalOf(view: SessionOpenView) {
  return "error" in view.goal && view.goal.error.code === GOAL_UNAVAILABLE ? NO_GOAL : factValue(view.goal)
}

export function readSession(context: SessionContext, ref: SessionRef, held?: HeldSessionReads): SessionReads {
  const { transport } = context
  const opened = onRuntime<SessionOpenView | undefined>(
    context,
    ref,
    async (route) => sessionOpenFromWire(await transport.runtimeJson<unknown>(route, withQuery(sessionEndpoint(ref), OPEN_VIEW))),
    async () => undefined,
  )
  const fact = <T>(read: (view: SessionOpenView) => T, stopped: T) => opened.then((view) => (view ? read(view) : stopped))
  return {
    surface: readSurface(context, ref, opened.then((view) => view?.session), held?.latestTurn),
    outline: held?.outline ? Promise.resolve(held.outline) : readOutline(context, ref),
    status: fact((view) => context.status.read(ref, view.session, view.status), STOPPED_STATUS),
    requests: fact((view) => factValue(view.requests), []),
    todos: fact((view) => factValue(view.todos), []),
    goal: fact(goalOf, NO_GOAL),
    subagents: fact((view) => factValue(view.subagents), []),
  }
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  return readHistory(context, ref, await context.workspaces.home(ref), cursor)
}
