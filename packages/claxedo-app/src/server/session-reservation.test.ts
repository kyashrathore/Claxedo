import { expect, test } from "bun:test"
import { resolveHostedOperation } from "@claxedo/account-contract"
import { createHostedAccount } from "./account"
import { ServerError } from "./errors"
import { createReserved, reserveSession } from "./session-reservation"
import type { ReservationHold, SessionReservation } from "./types"

function reservingAccount() {
  const reserved: string[] = []
  const account = createHostedAccount(async (operation, input) => {
    const body = resolveHostedOperation(operation, input).body as { sessionId: string }
    reserved.push(body.sessionId)
    return { ...body, state: "reserved" }
  })
  return { account, reserved }
}

function draftHold(): ReservationHold & { current: () => SessionReservation | undefined } {
  let held: SessionReservation | undefined
  return { held: () => held, hold: (next) => { held = next }, current: () => held }
}

const refused = (code: string, status: number) => new ServerError({ class: status === 409 ? "conflict" : "auth", status, code, message: code })

test("a session is reserved through the account, and an answer for another session is refused", async () => {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => {
    runs.push({ operation, input })
    return { ...resolveHostedOperation(operation, input).body, state: "reserved" }
  })
  const reservation = await reserveSession(account, { workspaceId: "ws_cloud", title: "Cloud" })
  expect(runs).toEqual([{ operation: "session.reserve", input: { workspaceId: "ws_cloud", title: "Cloud", operationId: reservation.operationId, sessionId: reservation.sessionId } }])
  const other = createHostedAccount(async () => ({ sessionId: "ses_other", operationId: "op_other", state: "reserved" }))
  await expect(reserveSession(other, { workspaceId: "ws_cloud" })).rejects.toMatchObject({ class: "internal" })
})

test("a draft keeps its reservation through failed creates, Edit and reload, so a lost create answer never makes a second session", async () => {
  const { account, reserved } = reservingAccount()
  const hold = draftHold()
  const tried: string[] = []
  const failing = async (reservation: SessionReservation) => {
    tried.push(reservation.sessionId)
    throw refused("workspace_authorization_denied", 403)
  }
  await expect(createReserved(account, hold, { workspaceId: "ws_cloud" }, failing)).rejects.toMatchObject({ status: 403 })
  const reloaded = { held: () => structuredClone(hold.current()), hold: hold.hold }
  await expect(createReserved(account, reloaded, { workspaceId: "ws_cloud" }, failing)).rejects.toMatchObject({ status: 403 })
  expect(reserved).toHaveLength(1)
  expect(tried).toEqual([reserved[0], reserved[0]])
  await createReserved(account, hold, { workspaceId: "ws_other" }, async (reservation) => reservation)
  expect(reserved).toHaveLength(2)
  expect(hold.current()?.workspaceId).toBe("ws_other")
})

test("a create refused because its reservation was spent reserves again once and creates under the new one", async () => {
  const { account, reserved } = reservingAccount()
  const hold = draftHold()
  hold.hold(await reserveSession(account, { workspaceId: "ws_cloud" }))
  const tried: string[] = []
  const created = await createReserved(account, hold, { workspaceId: "ws_cloud" }, async (reservation) => {
    tried.push(reservation.sessionId)
    if (tried.length === 1) throw refused("session_reservation_spent", 409)
    return reservation
  })
  expect(reserved).toHaveLength(2)
  expect(tried).toEqual(reserved)
  expect(created.sessionId).toBe(reserved[1])
  expect(hold.current()?.sessionId).toBe(reserved[1])
})
