import { expect, test } from "bun:test"
import { resolveHostedOperation, type HostedOperationName } from "@claxedo/account-contract"
import { createHostedAccount } from "./account"
import { reserveSession } from "./session-reservation"
import type { Transport } from "./transport"

test("with an account, a cloud session is reserved through the account and never through the daemon", async () => {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => {
    runs.push({ operation, input })
    return { ...resolveHostedOperation(operation as HostedOperationName, input).body, state: "reserved" }
  })
  const daemon = { json: async () => { throw new Error("the daemon reserves no account session") } } as unknown as Transport
  const reservation = await reserveSession(daemon, { workspaceId: "ws_cloud", title: "Cloud" }, account)
  expect(runs).toEqual([{ operation: "session.reserve", input: { ...reservation, workspaceId: "ws_cloud", title: "Cloud" } }])
})
