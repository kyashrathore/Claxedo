import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import { reservePort, releasePort } from "../../../e2e/harness/ports"
import { startScriptedModelServer, type ScriptedModelServer } from "../../../e2e/harness/scripted-model-server"
import type { ResolvedCredentials } from "../../contract"
import { PiDurableTransport } from "../../transports/pi-durable"
import { createNodePiPlacement } from "../../transports/pi-durable/node"
import { withUndeliverableFile, type SuiteBackend } from "./run"
import type { TestServices } from "./services"

export type PiBackend = SuiteBackend & { root: string; server: ScriptedModelServer; secret: string }

export function piDirect(server: ScriptedModelServer, secret: string): ProviderDirect {
  return { delivery: "direct", baseUrl: server.url, apiPath: "/v1", secret, authKind: "api-key",
    account: { credentialId: `cred-${secret}`, providerId: "openai", label: secret } }
}

export function piCredentials(server: ScriptedModelServer, secret: string): ResolvedCredentials {
  return { accountOwner: "owner", machineLoginAllowed: false, providers: {}, direct: { openai: piDirect(server, secret) }, secrets: {},
    leaseGeneration: secret }
}

export async function piBackend(name = "pi-durable"): Promise<PiBackend> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`)))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const authFile = path.join(root, "home", ".pi", "agent", "auth.json")
  await fs.mkdir(path.dirname(authFile), { recursive: true })
  await fs.writeFile(authFile, '{"sentinel":"owner-auth-must-stay"}\n')
  const port = await reservePort()
  const server = await startScriptedModelServer({ port, red: false })
  const rotated: { port: number; server: ScriptedModelServer }[] = []
  return {
    root, directory, server, secret: "pi-direct-secret", authFile, execution: "in-process", owner: { kind: "machine-owner" },
    harness: { id: "pi", access: "native" }, model: { providerID: "pi", modelID: "openai/gpt-4.1" },
    credentials: piCredentials(server, "pi-direct-secret"), credentialsAfterActiveTurns: true, unrunnableTurn: withUndeliverableFile,
    sharedSender: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    hold: (marker) => server.holdTextReplies(marker), held: (marker) => server.textGateReached(marker),
    scriptTool: (toolName, input) => server.scriptTool({ name: toolName, input }), scriptThinking: (input) => server.scriptText(input),
    rotate: async () => {
      const next = { port: await reservePort(), server: undefined as unknown as ScriptedModelServer }
      next.server = await startScriptedModelServer({ port: next.port, red: false })
      rotated.push(next)
      return { credentials: piCredentials(next.server, "pi-rotated-secret"), observed: () => next.server.requests.length > 0 }
    },
    close: async () => {
      for (const entry of [{ port, server }, ...rotated]) { await entry.server.close(); releasePort(entry.port) }
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export function piTransport(services: TestServices, backend: { root: string }) {
  return new PiDurableTransport(services, createNodePiPlacement({ stateRoot: path.join(backend.root, "state"), services,
    env: { PATH: process.env.PATH, HOME: path.join(backend.root, "home"), CLAXEDO_SERVER_TOKEN: "daemon-secret" } }))
}

