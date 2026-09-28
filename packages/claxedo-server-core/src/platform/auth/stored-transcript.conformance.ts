import type { PrivateSessionAuthority } from "./private-session-authority"
import type { SessionTurnAuthority } from "./session-turn-authority"
import type { SessionPageConformanceUser } from "./session-page.conformance"

/** A registry and the workspace its creator stores transcripts in, for the conformance suites that read a stored transcript back. */
export type TranscriptConformanceHarness = {
  authority: PrivateSessionAuthority & SessionTurnAuthority
  workspaceId: string
  creator: SessionPageConformanceUser
}

export type SyncedMessage = { info: { id: string; role: "user" | "assistant" } & Record<string, unknown>; parts: Array<Record<string, unknown>> }

/** A runtime's snapshot of one message of `sessionId`, created at ten times the digits of its id, each part keyed `<id>-p<index>`. */
export function syncedMessage(
  sessionId: string,
  id: string,
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): SyncedMessage {
  const at = Number(id.replace(/\D/g, "")) * 10
  return {
    info: { id, sessionID: sessionId, role, time: { created: at, ...(role === "assistant" ? { completed: at + 5 } : {}) }, ...extra },
    parts: parts.map((part, index) => ({ id: `${id}-p${index}`, sessionID: sessionId, messageID: id, ...part })),
  }
}

/** Reserves `sessionId` for the creator and registers it as the runtime's. */
export async function registerTranscriptSession(harness: TranscriptConformanceHarness, sessionId: string) {
  const { authority, workspaceId, creator } = harness
  await authority.reserveSession(creator.auth, { operationId: `op_${sessionId}`, sessionId, workspaceId, kind: "create" })
  await authority.registerRuntimeSession({ ...creator.runtime, operationId: `op_${sessionId}`, sessionId, workspaceId })
}

/** Stores `messages` as the session's transcript, each user message first admitted as a turn the creator produced. */
export async function syncTranscript(harness: TranscriptConformanceHarness, sessionId: string, messages: SyncedMessage[]) {
  const { authority, workspaceId, creator } = harness
  const runtime = { ...creator.runtime, sessionId, workspaceId }
  let fencingToken: number | undefined
  for (const message of messages.filter((item) => item.info.role === "user")) {
    const lease = await authority.acquireSessionTurn({ ...runtime, turnId: message.info.id })
    await authority.releaseSessionTurn({ ...runtime, turnId: message.info.id, leaseId: lease.leaseId, fencingToken: lease.fencingToken })
    fencingToken = lease.fencingToken
  }
  await authority.syncSessionMessages(creator.auth, {
    sessionId,
    workspaceId,
    maxEventOrdinal: messages.length,
    ...(fencingToken === undefined ? {} : { fencingToken }),
    messages,
  })
}
