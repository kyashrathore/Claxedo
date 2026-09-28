import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h14-codex-mcp" })
  const mcp = await startScriptedMcpServer()
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h14-codex-mcp")
    const applied = await applyScriptedPluginProfile(stack.url, {
      harnessIds: ["codex"],
      servers: { scripted: { type: "streamable-http", url: mcp.url } },
    })
    assert.equal(applied.active, true)
    await stack.daemon.restart()
    if (process.env.CLAXEDO_E2E_REFUSE_MCP_TOOL === "1") mcp.refuseToolCalls()
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "codex", modelId: "gpt-5.5" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, title: "H14 MCP Codex", permissionMode: "full-access", model,
    })
    await api.prompt(workspace.directory, session.id, "Inspect the plugin tools H14CODEXINIT", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "MCP Codex probe idle", timeoutMs: 60_000 })
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, `H-10: Codex never received the plugin's MCP server; advertised tools: ${JSON.stringify(stack.scripted.requests.filter((request) => request.dialect === "responses").map((request) => request.tools.map((item) => item.name)))}`)
    stack.scripted.scriptTool({ name: tool.name, input: { marker: "H14CODEX" }, whenPromptIncludes: "H14CODEX" })
    await api.prompt(workspace.directory, session.id, "Call the plugin MCP proof tool with marker H14CODEX", { model })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H14CODEX"), `H-10: Codex never called the plugin's MCP server; calls: ${JSON.stringify(mcp.calls)}`)
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H14CODEX/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H14 Codex: the plugin's HTTP MCP tool called, stored, streamed, and read back")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
