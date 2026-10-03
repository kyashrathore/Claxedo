import type { ScriptedModelServer } from "./scripted-model-server"
import { piCredentials, piTransport } from "./pi-conformance"
import { setupConformance, withUndeliverableFile } from "../../src/conformance/test-support/run"

const [root, directory, modelUrl, mode] = process.argv.slice(2) as [string, string, string, string | undefined]
const server = { url: modelUrl } as ScriptedModelServer
const context = await setupConformance({ name: "pi crash child",
  backend: async () => ({ directory, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
    model: { providerID: "pi", modelID: "openai/gpt-4.1" }, credentials: piCredentials(server, "pi-direct-secret"),
    unrunnableTurn: withUndeliverableFile, close: async () => {} }),
  makeTransport: (services) => piTransport(services, { root }) })
console.log(JSON.stringify({ binding: context.session.binding }))
if (mode === "ask") {
  await context.transport.config!.setPermissionMode(context.session, "ask")
  const asked = setInterval(() => {
    const pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    if (pending) { clearInterval(asked); console.log(JSON.stringify({ asked: pending })) }
  }, 20)
}
for await (const _event of context.transport.send(context.session, context.turn("Run it, then reply with exactly this one token: PICRASH"), context.turnBroker())) { void _event }
