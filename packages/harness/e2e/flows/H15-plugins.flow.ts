import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h15-claude-plugin" })
  const mcp = await startScriptedMcpServer()
  try {
    const applied = await applyScriptedPluginProfile(stack.url, mcp.url, ["claude"])
    assert.equal(applied.active, true)
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h15-claude-plugin")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "claude", modelId: "claude-sonnet-4-6" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "claude", access: "native" }, model, title: "H15 Claude plugin", permissionMode: "bypassPermissions",
    })
    await api.prompt(workspace.directory, session.id, "Inspect the enabled plugin tools H15PLUGININIT", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "Claude plugin probe idle", timeoutMs: 60_000 })
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, `C-7: the self-hosted stack gave Claude no plugin launch settings, so its plugin profile advertised no MCP proof tool: ${JSON.stringify(stack.scripted.requests.flatMap((request) => request.tools.map((item) => item.name)))}`)
    stack.scripted.scriptTool({ name: tool.name, input: { marker: "H15CLAUDE" }, whenPromptIncludes: "H15CLAUDE" })
    await api.prompt(workspace.directory, session.id, "Use the installed plugin proof tool with marker H15CLAUDE", { model })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H15CLAUDE"), "Claude must call the plugin's projected MCP tool")
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H15CLAUDE/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H15 Claude: signed plugin profile reached the Claude SDK and its MCP tool executed")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
