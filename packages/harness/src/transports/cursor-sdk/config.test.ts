import { expect, test } from "bun:test"
import type { HarnessServices, HarnessSession } from "../../contract"
import { CursorSdkTransport } from "./index"

test("Cursor config clears every nullable field and preserves omitted values", async () => {
  const transport = new CursorSdkTransport({} as HarnessServices, { homeRoot: "/tmp", worker: { file: process.execPath, args: ["cursor-worker.js"] }, env: {}, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: false })
  const session = { binding: { sessionId: "s1" } } as HarnessSession
  const config = { harness: { id: "cursor", access: "native" as const }, instructions: "keep", variant: "high", agent: "plan", permissionCeiling: "ask" as const }
  const entry = { session, input: { config } }
  ;(transport as unknown as { entries: Map<string, typeof entry> }).entries.set("s1", entry)
  const cleared = await transport.config.update(session, { instructions: null, variant: null, agent: null, group: null, handoff: null,
    permissionMode: null, model: null, permissionState: null })
  for (const field of ["instructions", "variant", "agent", "group", "handoff", "permissionMode", "model", "permissionState"] as const) {
    expect(cleared[field]).toBeUndefined()
  }
  expect(cleared.harness).toEqual(config.harness)
  expect(cleared.permissionCeiling).toBe("ask")
  await transport.config.update(session, { instructions: "new" })
  expect((await transport.config.update(session, { instructions: undefined })).instructions).toBe("new")
  expect(await transport.config.read(session)).toEqual(entry.input.config)
})
