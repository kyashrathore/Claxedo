import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import type { McpServerSpec, ProjectedMcpServer, ResolvedCredentials, RoutedEvent, SpawnCommand, StartInput } from "../contract"
import { createSessionBroker, createTurnBroker } from "../broker"
import { MCP_PROOF_TOOL, startMcpProofEndpoint, type McpProofEndpoint } from "../test-support/mcp-proof-endpoint"
import { authority, origin } from "./test-support/memory-ports"
import { piCredentials, piTransport } from "../../e2e/harness/pi-conformance"
import { setupConformance, withUndeliverableFile } from "./test-support/run"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"

const tempRoot = async (name: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name)))

function proofCredentials(endpoint: McpProofEndpoint, secret: string): ResolvedCredentials {
  return { accountOwner: "owner", machineLoginAllowed: false, providers: {}, secrets: {}, leaseGeneration: secret,
    direct: { groq: { delivery: "direct", baseUrl: endpoint.baseURL, apiPath: "/v1", secret, authKind: "api-key" } } }
}

type McpCase = { endpoint: McpProofEndpoint; firstParty?: McpServerSpec; configured?: ProjectedMcpServer[]; locality?: "local" | "remote" }

async function collect(events: AsyncIterable<RoutedEvent>): Promise<RoutedEvent[]> {
  const seen: RoutedEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

async function mcpTurn(root: string, input: McpCase) {
  const commands: SpawnCommand[] = []
  const context = await setupConformance({
    name: "pi mcp",
    backend: async () => ({ directory: root, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
      model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, unrunnableTurn: withUndeliverableFile, locality: input.locality ?? "local",
      credentials: proofCredentials(input.endpoint, "proof-secret"),
      projection: { generation: "g1", pluginRoots: [], mcpServers: input.configured ?? [], notApplied: [] },
      configureServices: (services) => {
        services.firstPartyMcp = () => input.firstParty
        const spawn = services.spawn.bind(services)
        services.spawn = (command, options) => { commands.push(command); return spawn(command, options) }
      },
      close: async () => { input.endpoint.stop(); await fs.rm(root, { recursive: true, force: true }) } }),
    makeTransport: (services) => piTransport(services, { root }),
  })
  try {
    const events = await collect(context.transport.send(context.session, context.turn("Read the app plugin guide"), context.turnBroker()))
    const files = await fs.readdir(root, { recursive: true, withFileTypes: true })
    const texts = await Promise.all(files.filter((entry) => entry.isFile()).map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "latin1")))
    return { events, commands, texts }
  } finally { await context.close() }
}

test("Pi calls Claxedo's first-party MCP tool with the session's bearer, which never reaches a command line or a file", async () => {
  const root = await tempRoot("pi-first-party-mcp-")
  const endpoint = startMcpProofEndpoint()
  const bearer = "Bearer pi-mcp-proof-bearer"
  const turn = await mcpTurn(root, { endpoint, firstParty: { kind: "http", name: "claxedo", url: `${endpoint.baseURL}/mcp`, headers: { authorization: bearer } } })
  expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
  expect(endpoint.called).toEqual([bearer])
  expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
  for (const command of turn.commands) expect(JSON.stringify(command)).not.toContain("pi-mcp-proof-bearer")
  for (const text of turn.texts) expect(text).not.toContain("pi-mcp-proof-bearer")
}, 60_000)

test("a remote Pi session calls the first-party MCP server its host offers", async () => {
  const root = await tempRoot("pi-remote-mcp-")
  const endpoint = startMcpProofEndpoint()
  const bearer = "Bearer pi-remote-mcp-bearer"
  const turn = await mcpTurn(root, { endpoint, locality: "remote", firstParty: { kind: "http", name: "claxedo", url: `${endpoint.baseURL}/mcp`, headers: { authorization: bearer } } })
  expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
  expect(endpoint.called).toEqual([bearer])
  expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
}, 60_000)

test("Pi calls a person's configured HTTP MCP server with its header kept literal", async () => {
  const root = await tempRoot("pi-configured-mcp-")
  const endpoint = startMcpProofEndpoint("mcp__docs__app_plugin_guide")
  const header = "Bearer $DOCS_TOKEN !not-a-command"
  const turn = await mcpTurn(root, { endpoint,
    configured: [{ kind: "http", name: "docs", url: `${endpoint.baseURL}/mcp`, headers: { authorization: header }, origin: "configured" }] })
  expect(endpoint.called).toEqual([header])
  expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
}, 60_000)

test("Pi starts a stdio MCP server through the owned spawn with its literal env and none of the daemon's, and drains what it writes to stderr", async () => {
  const root = await tempRoot("pi-stdio-mcp-")
  const endpoint = startMcpProofEndpoint("mcp__local__app_plugin_guide")
  const outside = await tempRoot("pi-stdio-proof-")
  const server = path.join(outside, "stdio-mcp.js")
  const proof = path.join(outside, "stdio-env.json")
  await fs.writeFile(server, `const readline = require("node:readline");
const fs = require("node:fs");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-proof", version: "1" } });
  if (message.method === "tools/list") return reply({ tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] });
  if (message.method === "tools/call") { fs.writeSync(2, "x".repeat(256 * 1024)); fs.writeFileSync(process.env.PROOF_FILE, JSON.stringify(process.env)); return reply({ content: [{ type: "text", text: "stdio proof" }] }); }
});
`)
  try {
    const turn = await mcpTurn(root, { endpoint, configured: [{ kind: "stdio", name: "local", command: process.execPath, args: [server],
      env: { PROOF_FILE: proof, PROOF_VALUE: "!echo $HOME" }, origin: "configured" }] })
    const env = JSON.parse(await fs.readFile(proof, "utf8")) as Record<string, string>
    expect(env.PROOF_VALUE).toBe("!echo $HOME")
    expect(env.CLAXEDO_SERVER_TOKEN).toBeUndefined()
    expect(turn.commands.some((command) => command.args.includes(server))).toBe(true)
    expect(JSON.stringify(turn.events)).toContain("MCP proof complete")
  } finally { await fs.rm(outside, { recursive: true, force: true }) }
}, 60_000)

test("two Pi sessions in one process see only their own MCP tools and spend only their own credential", async () => {
  const root = await tempRoot("pi-isolation-")
  const alpha = startMcpProofEndpoint("mcp__alpha__app_plugin_guide")
  const beta = startMcpProofEndpoint("mcp__beta__app_plugin_guide")
  const port = await reservePort()
  const scripted = await startScriptedModelServer({ port, red: false })
  const context = await setupConformance({ name: "pi isolation",
    backend: async () => ({ directory: root, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
      model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, unrunnableTurn: withUndeliverableFile,
      credentials: proofCredentials(alpha, "alpha-secret"),
      projection: { generation: "alpha", pluginRoots: [], notApplied: [], mcpServers: [{ kind: "http", name: "alpha", url: `${alpha.baseURL}/mcp`, origin: "plugin" }] },
      close: async () => { alpha.stop(); beta.stop(); await scripted.close(); releasePort(port); await fs.rm(root, { recursive: true, force: true }) } }),
    makeTransport: (services) => piTransport(services, { root }) })
  try {
    context.ports.current.set("s2", { ...authority, sessionId: "s2", directory: root })
    context.ports.directories.set("s2", root)
    const start: StartInput = { ...context.start, sessionId: "s2", credentials: proofCredentials(beta, "beta-secret"),
      projection: { generation: "beta", pluginRoots: [], notApplied: [], mcpServers: [{ kind: "http", name: "beta", url: `${beta.baseURL}/mcp`, origin: "plugin" }] } }
    const second = await context.transport.start(start, createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w1", directory: root, origin }))
    expect(second.binding.upstreamSessionId).not.toBe(context.session.binding.upstreamSessionId)
    const secondTurn = createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin, signal: new AbortController().signal })
    await Promise.all([collect(context.transport.send(context.session, context.turn("Read the app plugin guide"), context.turnBroker())),
      collect(context.transport.send(second, context.turn("Read the app plugin guide"), secondTurn))])
    expect(alpha.offered.filter((name) => name.startsWith("mcp__"))).toEqual(["mcp__alpha__app_plugin_guide", "mcp__alpha__app_plugin_guide"])
    expect(beta.offered.filter((name) => name.startsWith("mcp__"))).toEqual(["mcp__beta__app_plugin_guide", "mcp__beta__app_plugin_guide"])
    await context.transport.configure(context.session, { credentials: piCredentials(scripted, "alpha-renewed") })
    await context.transport.configure(second, { credentials: piCredentials(scripted, "beta-renewed") })
    const openai = { providerID: "pi", modelID: "openai/gpt-4.1" }
    await collect(context.transport.send(context.session, { ...context.turn("Reply with exactly this one token: ALPHA"), model: openai }, context.turnBroker()))
    await collect(context.transport.send(second, { ...context.turn("Reply with exactly this one token: BETA"), model: openai }, secondTurn))
    const seen = (marker: string) => new Set(scripted.requests.filter((request) => request.prompt.includes(marker)).map((request) => request.authorization))
    expect(seen("ALPHA")).toEqual(new Set(["Bearer alpha-renewed"]))
    expect(seen("BETA")).toEqual(new Set(["Bearer beta-renewed"]))
  } finally { await context.close() }
}, 60_000)

test("a reattached Pi session offers its MCP tools from the recorded list and starts the server only when a tool is called", async () => {
  const root = await tempRoot("pi-lazy-mcp-")
  const endpoint = startMcpProofEndpoint("mcp__local__app_plugin_guide")
  const outside = await tempRoot("pi-lazy-mcp-proof-")
  const server = path.join(outside, "stdio-mcp.js")
  const starts = path.join(outside, "starts.log")
  await fs.writeFile(server, `const readline = require("node:readline");
require("node:fs").appendFileSync(${JSON.stringify(starts)}, "start\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lazy-proof", version: "1" } });
  if (message.method === "tools/list") return reply({ tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] });
  if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "lazy proof" }] });
});
`)
  await fs.writeFile(starts, "")
  const startCount = async () => (await fs.readFile(starts, "utf8")).split("\n").filter(Boolean).length
  const context = await setupConformance({ name: "pi lazy mcp",
    backend: async () => ({ directory: root, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
      model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, unrunnableTurn: withUndeliverableFile, locality: "local",
      credentials: proofCredentials(endpoint, "proof-secret"),
      projection: { generation: "g1", pluginRoots: [], notApplied: [],
        mcpServers: [{ kind: "stdio", name: "local", command: process.execPath, args: [server], env: {}, origin: "configured" }] },
      close: async () => { endpoint.stop(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }) } }),
    makeTransport: (services) => piTransport(services, { root }) })
  try {
    await collect(context.transport.send(context.session, context.turn("Read the app plugin guide"), context.turnBroker()))
    expect(await startCount()).toBe(1)
    await context.transport.close(context.session)
    const attached = await context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: true }, context.sessionBroker)
    expect(await startCount()).toBe(1)
    const offeredBefore = endpoint.offered.length
    const events = await collect(context.transport.send(attached, context.turn("Read the app plugin guide"), context.turnBroker()))
    expect(endpoint.offered.slice(offeredBefore)).toContain("mcp__local__app_plugin_guide")
    expect(JSON.stringify(events)).toContain("MCP proof complete")
    expect(await startCount()).toBe(2)
  } finally { await context.close() }
}, 60_000)
