import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { pinnedPiExecutable } from "../../test-utils/pinned-pi"
import { MCP_PROOF_TOOL, startMcpProofEndpoint } from "../../test-utils/mcp-proof-endpoint.mjs"

const binary = pinnedPiExecutable()

test("pi lists and executes a Claxedo MCP tool through its real native harness", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-pi-mcp-")))
  const endpoint = startMcpProofEndpoint()
  const store = createMemoryRuntimeStore()
  const adapter = new PiHarnessAdapter({ store, binary, agentDir: path.join(directory, "pi") })
  try {
    await adapter.applyConfig({
      mcp: {},
      auth: { groq: { baseUrl: endpoint.baseURL, apiPath: "/v1", placeholder: "proof", authMode: "bearer", expiresAt: Date.now() + 60_000 } },
      firstPartyMcp: endpoint.firstPartyMcp,
    })
    adapter.setModel("groq/llama-3.1-8b-instant")
    const session = await adapter.createSession(directory, "MCP proof")
    const events = []
    for await (const event of adapter.executeTurn({ workspaceId: "proof", directory, sessionId: session.id, upstreamSessionId: store.getAgentSessionId(session.id) ?? session.id, connectionId: "native:pi" }, {
      parts: [{ type: "text", text: "Read the Claxedo app plugin guide" }], agent: "build", model: { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" }, assistantMessageId: "proof-turn",
    })) events.push(event)
    expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
    expect(endpoint.called).toEqual([session.id])
    expect(JSON.stringify(events)).toContain("MCP proof complete")
  } finally {
    await adapter.dispose()
    endpoint.stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60_000)
