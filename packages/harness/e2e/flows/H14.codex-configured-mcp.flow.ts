import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h14-codex-mcp" })
  const mcp = await startScriptedMcpServer()
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h14-codex-mcp")
    await api.configureMcp("scripted", mcp.url)
    assert.deepEqual(await api.mcpConfig(), { scripted: { type: "remote", url: mcp.url, headers: {} } })
    await stack.daemon.restart()
    if (process.env.CLAXEDO_E2E_REFUSE_MCP_TOOL === "1") mcp.refuseToolCalls()
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "codex", modelId: "gpt-5.5" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, title: "H14 MCP Codex", permissionMode: "full-access", model,
    })
    stack.scripted.scriptTool({ name: "mcp__scripted__proof", input: { marker: "H14CODEX" }, whenPromptIncludes: "H14CODEX" })
    await api.prompt(workspace.directory, session.id, "Call the scripted MCP proof tool with marker H14CODEX", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "MCP Codex turn idle", timeoutMs: 60_000 })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H14CODEX"), `H-10: Codex never received the configured MCP server; calls: ${JSON.stringify(mcp.calls)}; advertised tools: ${JSON.stringify(stack.scripted.requests.filter((request) => request.dialect === "responses").map((request) => request.tools.map((tool) => tool.name)))}`)
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H14CODEX/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H14 Codex: configured HTTP MCP tool called, stored, streamed, and read back")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
