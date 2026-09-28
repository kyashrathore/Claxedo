import { expect, test } from "bun:test"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate } from "../test-support/host-fixture"
import { createSessionConfiguration } from "./configure"

test("retry pushes only to attachments that have not acknowledged the configuration", async () => {
  let refused = true
  const accepted = new FakeTransport()
  const retried = new FakeTransport({ configure: () => refused ? { state: "refused", reason: "busy" } : { state: "applied" } })
  const host = createHostFixture({ transports: { pi: accepted, codex: retried } })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "accepted" }))
    await host.runtime.sessions.create(sessionCreate({ id: "refused", harness: { id: "codex", access: "native" } }))
    const configuration = createSessionConfiguration({
      attached: () => host.runtime.attachments.entries(),
      credentials: () => ({ providers: {}, secrets: {}, leaseGeneration: "new" }),
      projection: () => ({ generation: "new", mcpServers: [], pluginRoots: [], notApplied: [] }),
      providerDefinitions: () => [],
      onHeldFailure: (error) => { throw error },
    })
    await expect(configuration.apply({ credentials: true, projection: true, providerDefinitions: false })).rejects.toThrow("refused")
    refused = false
    await configuration.apply({ credentials: false, projection: false, providerDefinitions: false })
    expect(accepted.configures).toHaveLength(1)
    expect(retried.configures).toHaveLength(2)
    expect(retried.configures[1]).toEqual(retried.configures[0])
  } finally { await host.dispose() }
})
