import { expect, test } from "bun:test"
import { acpUnknown } from "./events"
import type { AcpEntry } from "./index"

test("ACP translator publishes an unrecognized session update outside a turn", async () => {
  const published: unknown[] = []
  const entry = { session: { binding: { upstreamSessionId: "up1" } }, broker: {
    publish: async (event: unknown) => { published.push(event) },
  } } as AcpEntry
  await acpUnknown(entry, "up1", "session/update", { sessionUpdate: "future_update" })
  expect(published[0]).toMatchObject({ type: "diagnostic", diagnostic: {
    code: "unrecognized-event", source: "acp.jsonrpc", method: "session/update",
  } })
})
