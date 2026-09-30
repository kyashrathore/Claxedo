import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { expect } from "bun:test"
import type { Frame } from "../../src/transports/codex-app-server/test-support/transport"
import { setupConformance, withUndeliverableFile, type ConformanceBackend, type SuiteBackend } from "../../src/conformance/test-support/run"
import type { TestServices } from "../../src/conformance/test-support/services"
import { PINNED_CODEX } from "./pinned-codex"
import { listenOnLoopback, reservePort, releasePort } from "./ports"
import { startScriptedModelServer } from "./scripted-model-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "./egress-guard"
import { CodexAppServerTransport, type Entry } from "../../src/transports/codex-app-server"
import type { HarnessTransport, ResolvedCredentials } from "../../src/contract"

export type CodexBackend = SuiteBackend & {
  root: string
  env: NodeJS.ProcessEnv
  server: Awaited<ReturnType<typeof startScriptedModelServer>>
}

export async function codexBackend(): Promise<CodexBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedModelServer({ port: modelPort, red: false })
  const guard = await startEgressGuard(guardPort)
  return {
    root, directory, server, env: { ...process.env, ...egressProxyEnv(guard.url) },
    harness: { id: "codex", access: "native" }, expectedMcp: "config",
    model: { providerID: "codex", modelID: "gpt-4.1" },
    credentials: { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: { openai: { baseUrl: server.v1Url, placeholder: "codex-conformance-placeholder", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "person", userId: "member" },
    origin: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    hold: (marker) => server.holdTextReplies(marker),
    held: (marker) => server.textGateReached(marker),
    scriptThinking: (input) => server.scriptText(input),
    unrunnableTurn: withUndeliverableFile,
    cleanupWithoutCommands: "verified_clear",
    close: async () => {
      console.log(`Codex outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await guard.close()
      await server.close()
      releasePort(modelPort)
      releasePort(guardPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

export function recordingBackend(): { backend: () => Promise<CodexBackend>; frames: Frame[]; received: Frame[] } {
  const frames: Frame[] = []
  const received: Frame[] = []
  return { frames, received, backend: async () => {
    const state = await codexBackend()
    state.configureServices = (services) => {
      const spawn = services.spawn.bind(services)
      services.spawn = async (command, options) => {
        const owned = await spawn(command, options)
        const write = owned.stdin.write.bind(owned.stdin)
        owned.stdin.write = ((chunk: string) => {
          for (const line of chunk.trim().split("\n")) frames.push(JSON.parse(line))
          return write(chunk)
        }) as typeof owned.stdin.write
        let partial = ""
        owned.stdout.on("data", (chunk: Buffer | string) => {
          const lines = `${partial}${chunk.toString()}`.split("\n")
          partial = lines.pop() ?? ""
          for (const line of lines) if (line.trim()) received.push(JSON.parse(line))
        })
        return owned
      }
    }
    return state
  } }
}

export function makeCodexTransport(services: TestServices, state: ConformanceBackend) {
  return new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
  })
}

export const OWNER_KEY = "owner-key-1"

export async function ownLoginContext(name: string, providers: ResolvedCredentials["providers"] = {}) {
  const state = await codexBackend()
  const ownerHome = path.join(state.root, "owner-codex")
  const mcpPort = await reservePort()
  const mcpRequests: string[] = []
  const mcp = createServer((request, response) => { mcpRequests.push(request.url ?? ""); response.writeHead(404).end() })
  await listenOnLoopback(mcp, mcpPort)
  await fs.mkdir(path.join(ownerHome, "skills", "owner-skill"), { recursive: true })
  await fs.writeFile(path.join(ownerHome, "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner skill\n---\nOwner\n")
  await fs.writeFile(path.join(ownerHome, "AGENTS.md"), "Owner instructions\n")
  await fs.writeFile(path.join(ownerHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: OWNER_KEY })}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(ownerHome, "config.toml"), [
    'model = "gpt-4.1"', 'model_provider = "owner-scripted"', "check_for_update_on_startup = false", "",
    "[model_providers.owner-scripted]", 'name = "Owner scripted provider"', `base_url = ${JSON.stringify(state.server.v1Url)}`,
    'wire_api = "responses"', "requires_openai_auth = true", "", "[mcp_servers.owner]",
    `url = ${JSON.stringify(`http:${String.fromCharCode(47, 47)}127.0.0.1:${mcpPort}/mcp`)}`, "",
  ].join("\n"))
  const ownLogin: CodexBackend = { ...state, owner: { kind: "machine-owner" }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers, secrets: {}, leaseGeneration: "own" },
    close: async () => {
      mcp.closeAllConnections()
      await new Promise<void>((resolve) => mcp.close(() => resolve()))
      releasePort(mcpPort)
      await state.close()
    } }
  const context = await setupConformance({ name, backend: async () => ownLogin, makeTransport: (services, backendState) => new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join((backendState as CodexBackend).root, "homes"), env: (backendState as CodexBackend).env, ownerHome,
  }) })
  return { context, ownerHome, mcpRequests, homes: path.join(state.root, "homes") }
}

export async function hashes(root: string): Promise<Record<string, string>> {
  const rows: Record<string, string> = {}
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else rows[path.relative(root, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex")
    }
  }
  await walk(root)
  return rows
}

export function codexEntry(transport: HarnessTransport, sessionId: string): Entry {
  return (transport as unknown as { sessions: { entries: Map<string, Entry> } }).sessions.entries.get(sessionId)!
}

export function entryHome(transport: HarnessTransport, sessionId: string): string {
  return codexEntry(transport, sessionId).home
}