import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { pluginFlowStep as step } from "../harness/plugin-flow"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await step("start isolated daemon and configure scripted providers", () => startStack({ label: "h15-claude-plugin" }))
  const mcp = await step("start proof MCP server", () => startScriptedMcpServer())
  try {
    const applied = await step("apply signed plugin generation", () => applyScriptedPluginProfile(stack.url, { harnessIds: ["claude"], servers: { proof: { type: "streamable-http", url: mcp.url } } }))
    assert.equal(applied.active, true)
    const api = new ClaxedoApi(stack.url)
    const workspace = await step("register the workspace", () => stack.daemon.makeWorkspace("h15-claude-plugin"))
    const stream = await step("open the workspace event stream", () => stack.events(workspace.directory))
    const model = { providerId: "claude", modelId: "claude-sonnet-4-6" }
    const session = await step("create native session", () => api.createSession(workspace.directory, {
      harness: { id: "claude", access: "native" }, model, title: "H15 Claude plugin", permissionMode: "bypassPermissions",
    }))
    await step("complete the Claude tool-discovery prompt HTTP response", () => api.prompt(workspace.directory, session.id, "Inspect the enabled plugin tools H15PLUGININIT", { model }))
    await step("observe probe session idle", () => stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "Claude plugin probe idle", timeoutMs: 60_000 }))
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, `C-7: the self-hosted stack gave Claude no plugin launch settings, so its plugin profile advertised no MCP proof tool: ${JSON.stringify(stack.scripted.requests.flatMap((request) => request.tools.map((item) => item.name)))}`)
    stack.scripted.scriptTool({ name: tool.name, input: { marker: "H15CLAUDE" }, whenPromptIncludes: "H15CLAUDE" })
    await step("complete the Claude proof-tool prompt HTTP response", () => api.prompt(workspace.directory, session.id, "Use the installed plugin proof tool with marker H15CLAUDE", { model }))
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H15CLAUDE"), "Claude must call the plugin's projected MCP tool")
    // The scripted model answers a tool result with a plain acknowledgement, so the
    // proof is the tool result reaching it, not the assistant's text.
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("MCP_PROOF:H15CLAUDE")), "the plugin tool's result never reached the model")
    assert.ok(assistantText(await step("read session messages", () => api.messages(workspace.directory, session.id))).length > 0)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await step("read session state", () => api.session(workspace.directory, session.id))).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H15 Claude: signed plugin profile reached the Claude SDK and its MCP tool executed")
  } finally {
    await step("close proof MCP server", () => mcp.close())
    await step("close the isolated stack", () => stack.close())
  }
}
