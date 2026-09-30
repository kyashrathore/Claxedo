import { AgentMessagePageError, readFirstRead, readTurnPage, type AgentMessagePageInput, type TurnPageQuery, type TurnRead } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { turnOutlineOfMessages } from "@claxedo/server-core/session/turn-outline"
import { storedTurn } from "@claxedo/server-core/session/latest-view-page"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { ControlPlaneServices } from "../authority/services"
import type { SessionReadPort } from "./routes/session-read"

function projectedMessagePage(
  services: ControlPlaneServices,
  sessionId: string,
  page: AgentMessagePageInput,
) {
  const read = services.projectionStore.read_session_message_page
  if (!read) throw new AgentMessagePageError(501, "message paging is unavailable for the session projection")
  return read(sessionId, page)
}

function projectedTurnRead(services: ControlPlaneServices, sessionId: string): TurnRead {
  return (before) => storedTurn(projectedMessagePage(services, sessionId, before === undefined ? { view: "latest-turn" } : { view: "latest-turn", before }))
}

async function projectedFirstRead(services: ControlPlaneServices, sessionId: string, firstPage: TurnPageQuery | undefined) {
  const meta = await services.projectionStore.session_meta(sessionId)
  if (!meta) return undefined
  return await readFirstRead(
    meta,
    turnOutlineOfMessages(services.projectionStore.read_session_messages(sessionId)),
    projectedTurnRead(services, sessionId),
    firstPage,
  )
}

/** The projection has no read of one message by id, so a part is found in the session's replay. */
async function projectedPart(services: ControlPlaneServices, sessionId: string, at: { messageId: string; partId: string }) {
  if (!(await services.projectionStore.session_meta(sessionId))) return undefined
  const message = services.projectionStore.read_session_messages(sessionId).find((item) => item.info.id === at.messageId)
  const part = message?.parts.find((item) => item.id === at.partId)
  return part ? { part } : {}
}

async function projectedPage(services: ControlPlaneServices, sessionId: string, page: TurnPageQuery & { before: string }) {
  if (!(await services.projectionStore.session_meta(sessionId))) return undefined
  return await readTurnPage(projectedTurnRead(services, sessionId), page)
}

export function projectionSessionReads(services: ControlPlaneServices): SessionReadPort<SignedControlPlaneAuth | undefined> {
  return {
    async messages(auth, input) {
      const { sessionId, workspaceId, page } = input
      if (auth) {
        const body = asRecord(await requireAuthority(services).readSessionMessages(auth, { sessionId, workspaceId: workspaceId!, ...page }))
        if (body?.allowed === false) return undefined
        return { ...body, maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId) }
      }
      const body = page
        ? projectedMessagePage(services, sessionId, page)
        : { messages: services.projectionStore.read_session_messages(sessionId) }
      return { ...body, maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId) }
    },
    firstRead: (auth, input) => auth
      ? requireAuthority(services).readSessionFirstRead(auth, { ...input, workspaceId: input.workspaceId! })
      : projectedFirstRead(services, input.sessionId, input.firstPage),
    page: (auth, input) => auth
      ? requireAuthority(services).readSessionPage(auth, { ...input, workspaceId: input.workspaceId! })
      : projectedPage(services, input.sessionId, input.page),
    part: (auth, input) => auth
      ? requireAuthority(services).readSessionPart(auth, { ...input, workspaceId: input.workspaceId! })
      : projectedPart(services, input.sessionId, input),
  }
}
