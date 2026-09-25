import { expect, test } from "bun:test"
import type { HarnessServices, SessionBroker, StartInput } from "../../contract"
import { ClaudeSdkTransport } from "./index"

test("a reconstructed binding attaches to the same Claude session without object identity", async () => {
  const transport = new ClaudeSdkTransport({} as HarnessServices, { executable: "claude", configRoot: "/tmp/claxedo-claude",
    userConfigRoot: "/tmp/person-claude", env: {} })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
    owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }
  const session = await transport.start(input, { rebind: async () => {} } as unknown as SessionBroker)
  const reconstructed = JSON.parse(JSON.stringify(session)) as typeof session
  expect(await transport.config.read(reconstructed)).toEqual(input.config)
  await expect(transport.config.read({ ...reconstructed, binding: { ...reconstructed.binding, workspaceId: "other" } }))
    .rejects.toMatchObject({ transport: "claude", code: "session" })
  await transport.close(session)
})
