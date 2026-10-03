import type { AgentTurnOutcome, SessionAttentionEvent, SessionAttentionFacts, SessionRef } from "@claxedo/agent-runtime-contract"
import type { SessionRowStatus } from "../../session/navigation-list"
import type { SignedControlPlaneAuth } from "./auth"
import type { SessionStateEvent } from "../runtime/lib/session-state-events"

/** Durable attention recovery and currently authorized notice delivery. */
export type SessionAttentionAuthority = {
  listSessionAttention?: (auth: SignedControlPlaneAuth, input: { after?: number; limit: number }) => Promise<AccountSessionAttentionPage>
  listSessionStateNotices?: (refs: readonly SessionRef[]) => Promise<SessionStateNotice[]>
  sessionNoticeVisible?: (auth: SignedControlPlaneAuth, ref: SessionRef, kind?: SessionStateEvent["type"]) => Promise<boolean>
  sessionPublicationNotices?: (refs: readonly SessionRef[], batches: readonly SessionAttentionBatch[]) => Promise<SessionStateEvent[]>
}

export type SessionAttentionBatch = SessionRef & {
  generation: number
  through: number
  events: readonly SessionAttentionEvent[]
}

export type AccountSessionAttentionEvent = SessionRef & {
  cursor: number
  projectId: string
  title?: string
  generation: number
  event: SessionAttentionEvent
}

export type AccountSessionAttentionPage = {
  events: AccountSessionAttentionEvent[]
  through: number
  next?: number
}

export type SessionStateNotice = SessionRef & {
  orgId: string
  projectId: string
  title?: string
  attention: SessionAttentionFacts
  lastTurn?: AgentTurnOutcome
  status: SessionRowStatus
  recipients: Array<{ userId: string }>
}
