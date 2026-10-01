import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { ServerError } from "./errors"
import { jsonInit, type Transport } from "./transport"
import { isRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"

export type SessionReservation = { readonly sessionId: string; readonly operationId: string }

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

const RESERVE_PATH = "/api/control/session-registrations/reserve"

export async function reserveSession(transport: Transport, input: { readonly workspaceId: string; readonly title?: string }, account?: HostedAccount): Promise<SessionReservation> {
  const reservation = { operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const params = { ...reservation, ...input }
  const body = account
    ? await account.run("session.reserve", params)
    : await transport.json<unknown>(RESERVE_PATH, jsonInit("POST", { ...params, kind: "create" }))
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return reservation
}
