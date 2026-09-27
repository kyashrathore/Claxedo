import { readCentralOpenTurn, readCentralPart, readCentralTurnPage } from "./central-session"
import { responseError, ServerError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { withQuery, type RuntimeRoute } from "./transport"
import type { PageShape, ReaderSettings, SessionRef, TranscriptPage, TranscriptPart, TurnPageRead } from "./types"
import { openTurnFromWire, partFromWire, settingsQuery, turnPageFromWire, viewportQuery } from "./wire/turn-page"

const NO_PAGE: TurnPageRead = { transcript: { entries: [] }, folded: new Map() }

async function runtimeBody(context: SessionContext, where: RuntimeRoute, path: string, what: string): Promise<unknown> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, what)
  return response.json()
}

async function readHistory<T>(
  context: SessionContext,
  ref: SessionRef,
  runtime: (where: RuntimeRoute) => Promise<T>,
  central: (workspaceId: string) => Promise<T>,
  offline: () => T,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (home.central) return central(home.route.workspaceId)
  return onRuntime(context, ref, runtime, async () => offline())
}

function offlineRefusal(what: string): never {
  throw new ServerError({ class: "network", message: `${what} cannot be read while the session's machine is offline` })
}

export function readTurnPageBefore(context: SessionContext, ref: SessionRef, shape: PageShape, before: string): Promise<TurnPageRead> {
  const path = withQuery(sessionEndpoint(ref, "/page"), { before, ...viewportQuery(shape) })
  return readHistory(
    context,
    ref,
    async (where) => turnPageFromWire(await runtimeBody(context, where, path, "Transcript page"), before),
    (workspaceId) => readCentralTurnPage(context, workspaceId, ref, shape, before),
    () => NO_PAGE,
  )
}

export function readTurnOpened(context: SessionContext, ref: SessionRef, settings: ReaderSettings, before: string | undefined): Promise<TranscriptPage> {
  const path = withQuery(sessionEndpoint(ref, "/turn"), { ...settingsQuery(settings), ...(before ? { before } : {}) })
  return readHistory(
    context,
    ref,
    async (where) => openTurnFromWire(await runtimeBody(context, where, path, "Opened turn")),
    (workspaceId) => readCentralOpenTurn(context, workspaceId, ref, settings, before),
    () => offlineRefusal("A folded turn"),
  )
}

export function readPart(context: SessionContext, ref: SessionRef, messageId: string, partId: string): Promise<TranscriptPart> {
  const path = sessionEndpoint(ref, `/message/${encodeURIComponent(messageId)}/part/${encodeURIComponent(partId)}`)
  return readHistory(
    context,
    ref,
    async (where) => partFromWire(await runtimeBody(context, where, path, "Tool part")),
    (workspaceId) => readCentralPart(context, workspaceId, ref, messageId, partId),
    () => offlineRefusal("A tool's output"),
  )
}
