import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { isRecord } from "@claxedo/helpers/guards"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import type { ReservationHold, SessionReservation } from "./types"

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

const SESSION_RESERVATION_SPENT = "session_reservation_spent"

type ReserveInput = { readonly workspaceId: string; readonly title?: string; readonly harness?: SessionHarness }

export async function reserveSession(account: HostedAccount, input: ReserveInput): Promise<SessionReservation> {
  const reservation = { workspaceId: input.workspaceId, operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const body = await account.run("session.reserve", { ...input, operationId: reservation.operationId, sessionId: reservation.sessionId })
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return typeof answer.sessionHostRoot === "string" ? { ...reservation, sessionHostRoot: answer.sessionHostRoot } : reservation
}

async function reserveHeld(account: HostedAccount, hold: ReservationHold | undefined, input: ReserveInput) {
  const reservation = await reserveSession(account, input)
  hold?.hold(reservation)
  return reservation
}

export async function createReserved<Created>(account: HostedAccount, hold: ReservationHold | undefined, input: ReserveInput, create: (reservation: SessionReservation) => Promise<Created>): Promise<Created> {
  const held = hold?.held()
  const reservation = held?.workspaceId === input.workspaceId ? held : await reserveHeld(account, hold, input)
  try {
    return await create(reservation)
  } catch (error) {
    if (!(error instanceof ServerError && error.code === SESSION_RESERVATION_SPENT)) throw error
    return await create(await reserveHeld(account, hold, input))
  }
}
