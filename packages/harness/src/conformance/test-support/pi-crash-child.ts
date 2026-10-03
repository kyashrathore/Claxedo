import type { ScriptedModelServer } from "../../../e2e/harness/scripted-model-server"
import { piCredentials, piTransport } from "./pi"
import { setupConformance, withUndeliverableFile } from "./run"

const [root, directory, modelUrl] = process.argv.slice(2) as [string, string, string]
const server = { url: modelUrl } as ScriptedModelServer
const context = await setupConformance({ name: "pi crash child",
  backend: async () => ({ directory, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
    model: { providerID: "pi", modelID: "openai/gpt-4.1" }, credentials: piCredentials(server, "pi-direct-secret"),
    unrunnableTurn: withUndeliverableFile, close: async () => {} }),
  makeTransport: (services) => piTransport(services, { root }) })
console.log(JSON.stringify({ binding: context.session.binding }))
for await (const _event of context.transport.send(context.session, context.turn("Run it, then reply with exactly this one token: PICRASH"), context.turnBroker())) { void _event }
