import type { D1Database } from "@cloudflare/workers-types"
import { readFirstRead, readTurnPage, type TurnPageQuery, type TurnPageRequest, type TurnRead } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { PrivateSessionInventoryRow } from "@claxedo/server-core/platform/auth/private-session-authority"
import { storedTurn } from "@claxedo/server-core/session/latest-view-page"
import type { LatestView } from "@claxedo/server-core/session/latest-view-page"
import { readStoredTurnOutline } from "@claxedo/server-core/session/turn-outline"
import { readStoredPart } from "@claxedo/server-core/session/stored-part"
import type { StoredMessageQuery } from "@claxedo/server-core/session/stored-messages"
import { requireText } from "./session-input"
import { decodeMessagePageCursor, readD1LatestView, readD1MessagePage, validateD1MessageRead } from "./session-read-store"

type ReadableSession = (auth: SignedControlPlaneAuth, sessionId: string, workspaceId: string) => Promise<{
  session: PrivateSessionInventoryRow
  role: "owner" | "viewer"
  maxEventOrdinal: number
} | undefined>

/** Read-only transcript projections; the authority admits each read before this owner queries its messages. */
export class D1SessionTranscriptRead {
  private readonly query: StoredMessageQuery

  constructor(private readonly database: D1Database, private readonly readable: ReadableSession) {
    this.query = async (sql, params) => (await database.prepare(sql).bind(...params).all()).results
  }

  async messages(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const before = validateD1MessageRead({ ...args, sessionId, workspaceId })
    const access = await this.readable(auth, sessionId, workspaceId)
    if (!access) return { allowed: false, messages: [] }
    return { allowed: true, role: access.role, maxEventOrdinal: access.maxEventOrdinal,
      ...await readD1MessagePage(this.database, { ...args, sessionId, workspaceId }, before) }
  }

  async firstRead(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; firstPage?: TurnPageRequest }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const session = await this.readable(auth, sessionId, workspaceId)
    if (!session) return undefined
    const outline = await readStoredTurnOutline(this.query, "data_json", sessionId, workspaceId)
    return readFirstRead(session.session, outline, this.turnRead(sessionId, workspaceId), args.firstPage)
  }

  async page(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; page: TurnPageQuery & { before: string } }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (!(await this.readable(auth, sessionId, workspaceId))) return undefined
    return readTurnPage(this.turnRead(sessionId, workspaceId), args.page)
  }

  async part(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; messageId: string; partId: string }) {
    const at = {
      sessionId: requireText(args.sessionId, "sessionId"),
      workspaceId: requireText(args.workspaceId, "workspaceId"),
      messageId: requireText(args.messageId, "messageId"),
      partId: requireText(args.partId, "partId"),
    }
    if (!(await this.readable(auth, at.sessionId, at.workspaceId))) return undefined
    const part = await readStoredPart(this.query, "data_json", at)
    return part ? { part } : {}
  }

  private turnRead(sessionId: string, workspaceId: string): TurnRead {
    return async (before) => storedTurn(await readD1LatestView(this.database, sessionId, workspaceId, "latest-turn",
      before === undefined ? undefined : decodeMessagePageCursor(sessionId, before)))
  }
}
