import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import type { McpServerSpec, ProjectedMcpServer, SpawnCommand } from "../contract"
import { PINNED_PI } from "../../e2e/harness/pinned-pi"
import { MCP_PROOF_TOOL, startMcpProofEndpoint, type McpProofEndpoint } from "../test-support/mcp-proof-endpoint"
import { PiRpcTransport } from "../transports/pi-rpc"
import { setupConformance, withUndeliverableFile } from "./test-support/run"

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

type McpCase = { endpoint: McpProofEndpoint; firstParty?: McpServerSpec; configured?: ProjectedMcpServer[] }

async function mcpTurn(root: string, input: McpCase) {
  const agentDir = path.join(root, "agent")
  await fs.mkdir(agentDir)
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { groq: { baseUrl: `${input.endpoint.baseURL}/v1`, apiKey: "proof" } } }))
  const commands: SpawnCommand[] = []
  const context = await setupConformance({
    name: "pi mcp",
    backend: async () => ({ directory: root, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
      model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, unrunnableTurn: withUndeliverableFile,
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "mcp" },
      projection: { generation: "g1", pluginRoots: [], mcpServers: input.configured ?? [], notApplied: [] },
      configureServices: (services) => {
        services.firstPartyMcp = (_sessionId, locality) => locality === "local" ? input.firstParty : undefined
        const spawn = services.spawn.bind(services)
        services.spawn = (command, options) => { commands.push(command); return spawn(command, options) }
      },
      close: async () => { input.endpoint.stop(); await fs.rm(root, { recursive: true, force: true }) } }),
    makeTransport: (services) => new PiRpcTransport(services, { binary: PINNED_PI, runtime: process.execPath, env: process.env,
      placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true, stateRoot: path.join(root, "claxedo"), ownerAgentDir: agentDir }),
  })
  const events: unknown[] = []
  try {
    for await (const event of context.transport.send(context.session, context.turn("Read the app plugin guide"), context.turnBroker())) events.push(event)
    const commandsList = await context.transport.commands!.list({ session: context.session })
    const files = await Promise.all((await listFiles(root)).map(async (file) => ({ file, text: await fs.readFile(file, "utf8") })))
    return { events, commands, commandsList, files }
  } finally { await context.close() }
}

const tempRoot = async (name: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name)))

test("Pi lists and calls Claxedo's MCP tool with the session's bearer through its own MCP, and the bearer is nowhere Pi's tools can read", async () => {
  const root = await tempRoot("pi-first-party-mcp-")
  const endpoint = startMcpProofEndpoint()
  const bearer = "Bearer pi-mcp-proof-bearer"
  const turn = await mcpTurn(root, { endpoint, firstParty: { kind: "http", name: "claxedo", url: `${endpoint.baseURL}/mcp`, headers: { authorization: bearer } } })
  expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
  expect(endpoint.called).toEqual([bearer])
  expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
  expect(turn.commandsList.some((command) => command.name === "claxedo-mcp")).toBe(false)
  for (const command of turn.commands) expect(JSON.stringify(command)).not.toContain("pi-mcp-proof-bearer")
  expect(turn.files.some(({ file }) => file.endsWith(".jsonl"))).toBe(true)
  expect(turn.files.filter(({ file }) => file.includes(`${path.sep}mcp-handoff${path.sep}`))).toEqual([])
  for (const { text } of turn.files) expect(text).not.toContain("pi-mcp-proof-bearer")
}, 60_000)

test("Pi calls a person's configured HTTP MCP server with its header kept literal", async () => {
  const root = await tempRoot("pi-configured-mcp-")
  const endpoint = startMcpProofEndpoint("mcp__docs__app_plugin_guide")
  const header = "Bearer $DOCS_TOKEN !not-a-command"
  const turn = await mcpTurn(root, { endpoint,
    configured: [{ kind: "http", name: "docs", url: `${endpoint.baseURL}/mcp`, headers: { authorization: header }, origin: "configured" }] })
  expect(endpoint.offered).toContain("mcp__docs__app_plugin_guide")
  expect(endpoint.called).toEqual([header])
  expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
}, 60_000)

test("Pi runs a person's configured stdio MCP server for a local session with its environment kept literal", async () => {
  const root = await tempRoot("pi-stdio-mcp-")
  const endpoint = startMcpProofEndpoint("mcp__local__app_plugin_guide")
  const outside = await tempRoot("pi-stdio-proof-")
  const server = path.join(outside, "stdio-mcp.js")
  const proof = path.join(outside, "stdio-called.txt")
  await fs.writeFile(server, `const readline = require("node:readline");
const fs = require("node:fs");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-proof", version: "1" } });
  if (message.method === "tools/list") return reply({ tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] });
  if (message.method === "tools/call") { fs.writeFileSync(process.env.PROOF_FILE, process.env.PROOF_VALUE); return reply({ content: [{ type: "text", text: "stdio proof" }] }); }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }) + "\\n");
});
`)
  const turn = await mcpTurn(root, { endpoint, configured: [{ kind: "stdio", name: "local", command: process.execPath, args: [server],
    env: { PROOF_FILE: proof, PROOF_VALUE: "!echo $HOME" }, origin: "configured" }] })
  try {
    expect(endpoint.offered).toContain("mcp__local__app_plugin_guide")
    expect(await fs.readFile(proof, "utf8")).toBe("!echo $HOME")
    expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
  } finally { await fs.rm(outside, { recursive: true, force: true }) }
}, 60_000)
