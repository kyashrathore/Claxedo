import { expect, test } from "bun:test"
import { resolveHostedOperation } from "@claxedo/account-contract"
import { createHostedAccount } from "./account"
import { createSessionReservations, reserveSession } from "./session-reservation"

test("a session is reserved through the account, and an answer for another session is refused", async () => {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => {
    runs.push({ operation, input })
    return { ...resolveHostedOperation(operation, input).body, state: "reserved" }
  })
  const reservation = await reserveSession(account, { workspaceId: "ws_cloud", title: "Cloud" })
  expect(runs).toEqual([{ operation: "session.reserve", input: { ...reservation, workspaceId: "ws_cloud", title: "Cloud" } }])
  const other = createHostedAccount(async () => ({ sessionId: "ses_other", operationId: "op_other", state: "reserved" }))
  await expect(reserveSession(other, { workspaceId: "ws_cloud" })).rejects.toMatchObject({ class: "internal" })
})

test("a retried create of the same first message keeps its reservation until the create succeeds", async () => {
  let runs = 0
  const account = createHostedAccount(async (operation, input) => {
    runs += 1
    return { ...resolveHostedOperation(operation, input).body, state: "reserved" }
  })
  const reservations = createSessionReservations(account)

  const first = await reservations.reserve("msg_1", { workspaceId: "ws_cloud" })
  expect(await reservations.reserve("msg_1", { workspaceId: "ws_cloud" })).toBe(first)
  expect(runs).toBe(1)

  expect(await reservations.reserve("msg_1", { workspaceId: "ws_other" })).not.toMatchObject({ sessionId: first.sessionId })
  reservations.created("msg_1")
  expect(await reservations.reserve("msg_1", { workspaceId: "ws_cloud" })).not.toMatchObject({ sessionId: first.sessionId })
  expect(runs).toBe(3)
})
