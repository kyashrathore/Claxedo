import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MCP_PROOF_TOOL, startMcpProofEndpoint } from "../../../agent-sdk-runtime/src/test-utils/mcp-proof-endpoint.mjs"
import { OpenCodeSdkHarnessAdapter } from "../opencode/harness-adapter"
import { createOpenCodeRuntime } from "../opencode/runtime"

test("opencode lists and executes a Claxedo MCP tool through its real native harness", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-mcp-")))
  const endpoint = startMcpProofEndpoint()
  const engine = createOpenCodeRuntime({ databasePath: path.join(directory, "opencode.db"), configContent: JSON.stringify({
    model: "proof/proof", small_model: "proof/proof", enabled_providers: ["proof"],
    provider: { proof: { npm: "@ai-sdk/openai-compatible", models: { proof: { name: "Proof", limit: { context: 32000, output: 1024 } } }, options: { baseURL: `${endpoint.baseURL}/v1`, apiKey: "proof" } } },
  }) })
  const adapter = new OpenCodeSdkHarnessAdapter({ runtime: engine, workspaceID: "proof", directory, reportOwnerFailure: () => {} })
  try {
    await adapter.applyConfig({ mcp: {}, auth: {}, firstPartyMcp: endpoint.firstPartyMcp })
    const session = await adapter.createSession(directory, "MCP proof")
    const events = []
    for await (const event of adapter.executeTurn({ workspaceId: "proof", directory, sessionId: session.id, upstreamSessionId: session.id, connectionId: "native:opencode" }, {
      parts: [{ type: "text", text: "Read the Claxedo app plugin guide" }], agent: "build", model: { providerID: "proof", modelID: "proof" }, assistantMessageId: "proof-turn",
    })) events.push(event)
    expect(endpoint.offered).toContain(MCP_PROOF_TOOL)
    expect(endpoint.called).toEqual([session.id])
    expect(JSON.stringify(events)).toContain("MCP proof complete")
  } finally {
    await adapter.dispose()
    await engine.close()
    endpoint.stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60_000)
