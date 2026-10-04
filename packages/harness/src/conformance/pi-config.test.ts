import path from "node:path"
import { expect, test } from "bun:test"
import { piBackend, type PiBackend } from "../../e2e/harness/pi-conformance"
import { PiDurableTransport } from "../transports/pi-durable"
import { createNodePiPlacement } from "../transports/pi-durable/node"
import { setupConformance } from "./test-support/run"

test("Pi publishes its actual model catalog after turn-scoped credentials arrive", async () => {
  const context = await setupConformance({
    name: "pi-turn-config", backend: () => piBackend("pi-turn-config"),
    makeTransport: (services, backend) => {
      const pi = backend as PiBackend
      const placement = createNodePiPlacement({ services, stateRoot: path.join(pi.root, "state"), env: { PATH: process.env.PATH } })
      return new PiDurableTransport(services, { ...placement, prepareTurn: async () => ({ credentials: pi.credentials,
        projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, providerDefinitions: [] }) })
    },
  })
  try {
    await context.transport.configure(context.session, { credentials: { ...context.start.credentials, providers: {}, direct: {} } })
    const before = await context.transport.config!.options({ session: context.session }, "peek")
    expect(before.resolvedModel).toBeUndefined()
    const running = context.transport.send(context.session, context.turn("Reply with exactly this one token: PICONFIG"), context.turnBroker())
    const iterator = running[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.event).toMatchObject({ type: "config-update", options: expect.arrayContaining([expect.objectContaining({
      id: "model", currentValue: "openai/gpt-4.1", selectOptions: expect.arrayContaining([{ id: "openai/gpt-4.1", name: "GPT-4.1", connected: true }]),
    })]) })
    const after = await context.transport.config!.options({ session: context.session }, "peek")
    expect(first.value?.event.type === "config-update" && first.value.event.options).toEqual(after.options)
    for await (const _event of running) {}
  } finally { await context.close() }
}, 60_000)
