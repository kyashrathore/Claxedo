import { expect, test } from "bun:test"
import { resolveHostedOperation } from "@claxedo/account-contract"
import { createHostedAccount } from "./account"
import { ServerError } from "./errors"
import { createReserved, reserveSession } from "./session-reservation"
import type { ReservationHold, SessionReservation } from "./types"

function reservingAccount() {
  const reserved: string[] = []
  const harnesses: (string | undefined)[] = []
  const account = createHostedAccount(async (operation, input) => {
    const body = resolveHostedOperation(operation, input).body as { sessionId: string; harness?: { id: string } }
    reserved.push(body.sessionId)
    harnesses.push(body.harness?.id)
    return { ...body, state: "reserved" }
  })
  return { account, reserved, harnesses }
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

test("a draft that switches harness after a failed first send reserves again, since the control plane placed the held reservation by the harness it was reserved for", async () => {
  const { account, reserved, harnesses } = reservingAccount()
  const hold = draftHold()
  const claude = { workspaceId: "ws_cloud", harness: { id: "claude-sdk", access: "native" as const } }
  const pi = { workspaceId: "ws_cloud", harness: { id: "pi", access: "native" as const } }
  await expect(createReserved(account, hold, claude, async () => { throw refused("account_unavailable", 403) })).rejects.toMatchObject({ status: 403 })
  expect(hold.current()).toMatchObject({ sessionId: reserved[0], harness: claude.harness })
  const created = await createReserved(account, hold, pi, async (reservation) => reservation)
  expect(reserved).toHaveLength(2)
  expect(harnesses).toEqual(["claude-sdk", "pi"])
  expect(created.sessionId).toBe(reserved[1])
  expect(hold.current()).toMatchObject({ sessionId: reserved[1], harness: pi.harness })
  const again = await createReserved(account, { held: () => structuredClone(hold.current()), hold: hold.hold }, pi, async (reservation) => reservation)
  expect(again.sessionId).toBe(reserved[1])
  expect(reserved).toHaveLength(2)
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
