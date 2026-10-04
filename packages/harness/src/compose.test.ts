import { expect, test } from "bun:test"
import { createHarnessComposer, type HarnessCompositionOptions } from "./compose"
import { wireAgentCapabilities } from "./capabilities/wire"
import { createTestServices } from "./conformance/test-support/services"
import { acpConnectionConfig } from "./registry/providers/acp"

const unused = (): never => { throw new Error("only the ACP transport is composed here") }

test("an ACP connection's descriptor states what its composed transport offers before any agent handshake", async () => {
  const options: HarnessCompositionOptions = {
    pi: unused, codex: unused, claude: unused, cursor: unused, opencode: unused,
  }
  const hooks = acpConnectionConfig()
  const config = hooks.validateConfig({ label: "Local", connection: { kind: "process", command: "agent" } })
  const transport = createHarnessComposer(createTestServices(), options).connection({
    descriptor: { connectionId: "local", providerKey: "acp", configRevision: 1, enabled: true, config },
    expectedRevision: 1, directory: "/work", secrets: {},
  })
  const { harness: _harness, modelSelection: _modelSelection, ...live } = wireAgentCapabilities(
    await transport.capabilities({ directory: "/work" }), transport, { harness: "acp", transport: "acp", abort: true })
  await transport.dispose()

  expect(hooks.project(config).capabilities).toEqual(live)
  expect(live.questions).toBe(true)
})
