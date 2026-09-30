import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import type { SessionBroker, StartInput } from "@claxedo/harness/contract"
import { createHarnessComposer } from "@claxedo/harness/compose"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createHarnessServices } from "./harness-services"
import { requireCursorWorker } from "./host/executables/cursor"

const peerSource = `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const kind = process.env.COMPOSE_PEER_KIND;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  let response;
  if (kind === "pi") response = { type: "response", id: request.id, command: request.type, success: true,
    data: request.type === "get_state" ? { sessionId: "pi-peer" } : {} };
  else if (kind === "codex") response = { id: request.id, result: request.method === "thread/start" ? { thread: { id: "codex-peer" } }
    : request.method === "initialize" ? { userAgent: "codex_cli_rs/0.156.1 (Mac OS 26.6.2; arm64)" } : {} };
  else response = { jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: "acp-peer" } };
  if (request.id !== undefined) process.stdout.write(JSON.stringify(response) + "\\n");
});`

function startInput(directory: string, id: string, access: "native" | "connection"): StartInput {
  return { sessionId: "s1", workspaceId: "w1", directory, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id, access } }, projection: { generation: "g1", pluginRoots: [], mcpServers: [], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
}

function committed(directory: string, connectionId: string) {
  return async (upstreamSessionId: string) => ({ sessionId: "s1", workspaceId: "w1", directory, connectionId, upstreamSessionId })
}

test("harness package composition starts ACP, Pi, Codex, Claude and OpenCode and constructs Cursor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-compose-"))
  const peer = path.join(root, "peer.cjs")
  await fs.writeFile(peer, peerSource, { mode: 0o755 })
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const clock = { now: () => Date.now(), setTimeout, clearTimeout }
  const services = createHarnessServices({ ownership: volatileLaunchOwnership(), log, clock, patternEvaluator: async () => {}, healthChanged: () => {},
    transcripts: { workspaceId: "w1", resolver: { register: async () => ({ state: "ready", handle: "h1" }),
      open: async () => ({ state: "ready", messages: [] }) } } })
  const composer = createHarnessComposer(services, { acp: () => ({ missingContext: async () => { throw new Error("No saved context") } }),
    pi: () => ({ binary: peer, runtime: process.execPath, env: { ...process.env, COMPOSE_PEER_KIND: "pi" },
      placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(root, "pi-state"), ownerAgentDir: path.join(root, "pi-agent") }),
    codex: () => ({ binary: peer, homeRoot: path.join(root, "codex-homes"), ownerHome: path.join(root, "codex-owner"),
      env: { ...process.env, COMPOSE_PEER_KIND: "codex" } }),
    claude: () => ({ executable: "claude", configRoot: path.join(root, "claude-homes"),
      userConfigRoot: path.join(root, "claude-owner"), env: process.env }),
    cursor: () => ({ env: process.env, homeRoot: path.join(root, "cursor-homes"), worker: requireCursorWorker(process.env), placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true }),
    opencode: () => ({ databasePath: path.join(root, "opencode.db"), configContent: JSON.stringify({ model: "proof/proof",
      provider: { proof: { npm: "@ai-sdk/openai-compatible", name: "Proof", models: { proof: { name: "Proof", limit: { context: 32_000, output: 1_024 } } } } } }) }) })
  const brokerFor = (connectionId: string) => ({ rebind: committed(root, connectionId) }) as unknown as SessionBroker
  try {
    const acpDescriptor = { connectionId: "acp-1", providerKey: "acp", configRevision: 1, enabled: true,
      config: { label: "ACP", connection: { kind: "process", command: process.execPath, args: [peer],
        env: { COMPOSE_PEER_KIND: "acp" } }, secretBindings: { env: { TOKEN: "token" } } } }
    const acp = composer.connection({ descriptor: acpDescriptor, directory: root, expectedRevision: 1, secrets: { token: "resolved" } })
    try { expect((await acp.start(startInput(root, "acp", "connection"), brokerFor("acp-1"))).binding.upstreamSessionId).toBe("acp-peer") }
    finally { await acp.dispose() }
    const pi = composer.builtIn("pi")
    try { expect((await pi.start(startInput(root, "pi", "native"), brokerFor("pi-rpc"))).binding.upstreamSessionId).toBe("pi-peer") }
    finally { await pi.dispose() }
    const codex = composer.builtIn("codex")
    expect(codex.commands).toBeUndefined()
    try { expect((await codex.start(startInput(root, "codex", "native"), brokerFor("codex-app-server"))).binding.upstreamSessionId).toBe("codex-peer") }
    finally { await codex.dispose() }
    const claude = composer.builtIn("claude")
    try { expect((await claude.start(startInput(root, "claude", "native"), brokerFor("claude-sdk"))).binding.connectionId).toBe("claude-sdk") }
    finally { await claude.dispose() }
    const cursor = composer.builtIn("cursor")
    try { expect(cursor.kind).toBe("cursor-sdk") }
    finally { await cursor.dispose() }
    const opencode = composer.builtIn("opencode")
    try {
      const session = await opencode.start(startInput(root, "opencode", "native"), brokerFor("opencode-sdk"))
      expect(session.binding.connectionId).toBe("opencode-sdk")
      expect(session.binding.upstreamSessionId.length).toBeGreaterThan(0)
      await opencode.close(session)
    } finally { await opencode.dispose() }
    expect(() => composer.connection({ descriptor: { ...acpDescriptor, enabled: false }, directory: root,
      expectedRevision: 1, secrets: { token: "resolved" } })).toThrow("disabled or stale")
    expect(() => composer.connection({ descriptor: acpDescriptor, directory: root,
      expectedRevision: 2, secrets: { token: "resolved" } })).toThrow("disabled or stale")
    expect(() => composer.connection({ descriptor: acpDescriptor, directory: root,
      expectedRevision: 1, secrets: {} })).toThrow("Secret lease")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30_000)
