import { expect, test } from "bun:test"
import { resolveHostedOperation, type HostedOperationName } from "@claxedo/account-contract"
import { createHostedAccount } from "./account"
import { reserveSession } from "./session-reservation"

test("a session is reserved through the account, and an answer for another session is refused", async () => {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => {
    runs.push({ operation, input })
    return { ...resolveHostedOperation(operation as HostedOperationName, input).body, state: "reserved" }
  })
  const reservation = await reserveSession(account, { workspaceId: "ws_cloud", title: "Cloud" })
  expect(runs).toEqual([{ operation: "session.reserve", input: { ...reservation, workspaceId: "ws_cloud", title: "Cloud" } }])
  const other = createHostedAccount(async () => ({ sessionId: "ses_other", operationId: "op_other", state: "reserved" }))
  await expect(reserveSession(other, { workspaceId: "ws_cloud" })).rejects.toMatchObject({ class: "internal" })
})
