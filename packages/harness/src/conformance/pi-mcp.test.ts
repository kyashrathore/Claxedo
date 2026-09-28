import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { PINNED_PI } from "../../e2e/harness/pinned-pi"
import { MCP_PROOF_TOOL, startMcpProofEndpoint } from "../test-support/mcp-proof-endpoint"
import { PiRpcTransport } from "../transports/pi-rpc"
import { setupConformance, withUndeliverableFile } from "./test-support/run"

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

test("Pi lists and calls Claxedo's MCP tool with the session's bearer through its real extension", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-first-party-mcp-")))
  const endpoint = startMcpProofEndpoint()
  const bearer = "Bearer pi-mcp-proof-bearer"
  const agentDir = path.join(root, "agent")
  await fs.mkdir(agentDir)
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { groq: { baseUrl: `${endpoint.baseURL}/v1`, apiKey: "proof" } } }))
  const context = await setupConformance({
    name: "pi first-party mcp",
    backend: async () => ({ directory: root, harness: { id: "pi", access: "native" }, owner: { kind: "machine-owner" },
      model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, unrunnableTurn: withUndeliverableFile,
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "mcp" },
      configureServices: (services) => {
        services.firstPartyMcp = (sessionId, locality) => locality === "local"
          ? { ...endpoint.firstPartyMcp(sessionId), headers: { authorization: bearer } } : undefined
      },
      close: async () => { endpoint.stop(); await fs.rm(root, { recursive: true, force: true }) } }),
    makeTransport: (services) => new PiRpcTransport(services, { binary: PINNED_PI, runtime: process.execPath, env: process.env,
      placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true, stateRoot: path.join(root, "claxedo"), ownerAgentDir: agentDir }),
  })
  try {
    const events: unknown[] = []
    for await (const event of context.transport.send(context.session, context.turn("Read the Claxedo app plugin guide"), context.turnBroker())) events.push(event)
    expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
    expect(endpoint.called).toEqual([bearer])
    expect(JSON.stringify(events)).toContain("MCP proof complete")
    const commands = await context.transport.commands!.list({ session: context.session })
    expect(commands.some((command) => command.name === "claxedo-mcp")).toBe(false)
    const written = await listFiles(path.join(root, "claxedo"))
    expect(written.some((file) => file.endsWith(".jsonl"))).toBe(true)
    expect(written.filter((file) => file.includes(`${path.sep}mcp-handoff${path.sep}`))).toEqual([])
    for (const file of written) {
      if (!file.endsWith(".ts")) expect(await fs.readFile(file, "utf8")).not.toContain("pi-mcp-proof-bearer")
    }
  } finally { await context.close() }
}, 60_000)
