import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { isRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"
import { ServerError } from "./errors"
import type { ReservationHold, SessionReservation, SessionReservationIntent } from "./types"

export const RESERVATION_HEADER = "x-claxedo-session-registration-operation"

const SESSION_RESERVATION_SPENT = "session_reservation_spent"

function reservedFor(reservation: SessionReservation, intent: SessionReservationIntent): boolean {
  return reservation.workspaceId === intent.workspaceId
    && reservation.title === intent.title
    && reservation.harness?.id === intent.harness?.id
    && reservation.harness?.access === intent.harness?.access
}

export async function reserveSession(account: HostedAccount, intent: SessionReservationIntent): Promise<SessionReservation> {
  const reservation = { ...intent, operationId: prefixedRandomId("session_registration"), sessionId: prefixedRandomId("ses") }
  const body = await account.run("session.reserve", { ...intent, operationId: reservation.operationId, sessionId: reservation.sessionId })
  const answer = isRecord(body) ? body : {}
  if (answer.sessionId !== reservation.sessionId || answer.operationId !== reservation.operationId || answer.state !== "reserved") {
    throw new ServerError({ class: "internal", message: "The session reservation answered for a different session" })
  }
  return typeof answer.sessionHostRoot === "string" ? { ...reservation, sessionHostRoot: answer.sessionHostRoot } : reservation
}

async function reserveHeld(account: HostedAccount, hold: ReservationHold | undefined, intent: SessionReservationIntent) {
  const reservation = await reserveSession(account, intent)
  hold?.hold(reservation)
  return reservation
}

export async function createReserved<Created>(account: HostedAccount, hold: ReservationHold | undefined, intent: SessionReservationIntent, create: (reservation: SessionReservation) => Promise<Created>): Promise<Created> {
  const held = hold?.held()
  const reservation = held && reservedFor(held, intent) ? held : await reserveHeld(account, hold, intent)
  try {
    return await create(reservation)
  } catch (error) {
    if (!(error instanceof ServerError && error.code === SESSION_RESERVATION_SPENT)) throw error
    return await create(await reserveHeld(account, hold, intent))
  }
}
