import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { ServerError } from "./errors"
import { isRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"

export type SessionReservation = { readonly sessionId: string; readonly operationId: string }

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

export async function reserveSession(account: HostedAccount, input: { readonly workspaceId: string; readonly title?: string }): Promise<SessionReservation> {
  const reservation = { operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const body = await account.run("session.reserve", { ...reservation, ...input })
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return reservation
}
