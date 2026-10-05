import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { ServerError } from "./errors"
import { isRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"

export type SessionReservation = { readonly sessionId: string; readonly operationId: string; readonly sessionHostRoot?: string }

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

export async function reserveSession(account: HostedAccount, input: { readonly workspaceId: string; readonly title?: string; readonly harness?: SessionHarness }): Promise<SessionReservation> {
  const reservation = { operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const body = await account.run("session.reserve", { ...reservation, ...input })
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return typeof answer.sessionHostRoot === "string" ? { ...reservation, sessionHostRoot: answer.sessionHostRoot } : reservation
}

type ReserveInput = { readonly workspaceId: string; readonly title?: string; readonly harness?: SessionHarness }

/**
 * The reservation each first message's create holds until it succeeds, so a
 * retry of the same send creates under the same session id and operation:
 * the runtime then resumes or answers the session the first attempt made
 * instead of creating a second one.
 */
export function createSessionReservations(account: HostedAccount) {
  const held = new Map<string, { readonly workspaceId: string; readonly reservation: SessionReservation }>()
  return {
    async reserve(firstMessageId: string | undefined, input: ReserveInput): Promise<SessionReservation> {
      const kept = firstMessageId ? held.get(firstMessageId) : undefined
      if (kept?.workspaceId === input.workspaceId) return kept.reservation
      const reservation = await reserveSession(account, input)
      if (firstMessageId) held.set(firstMessageId, { workspaceId: input.workspaceId, reservation })
      return reservation
    },
    created(firstMessageId: string | undefined) {
      if (firstMessageId) held.delete(firstMessageId)
    },
  }
}

export type SessionReservations = ReturnType<typeof createSessionReservations>
