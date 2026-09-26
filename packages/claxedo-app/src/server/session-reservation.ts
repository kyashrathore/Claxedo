import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { ServerError } from "./errors"
import { jsonInit, type Transport } from "./transport"
import { isRecord } from "../lib/record"

export type SessionReservation = { readonly sessionId: string; readonly operationId: string }

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

const RESERVE_PATH = "/api/control/session-registrations/reserve"

export async function reserveSession(transport: Transport, input: { readonly workspaceId: string; readonly title?: string }): Promise<SessionReservation> {
  const reservation = { operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const body = await transport.json<unknown>(RESERVE_PATH, jsonInit("POST", { ...reservation, workspaceId: input.workspaceId, kind: "create", ...(input.title ? { title: input.title } : {}) }))
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return reservation
}
