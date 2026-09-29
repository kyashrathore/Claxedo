import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { pluginFlowStep as step, sharedCodexProfileConfig } from "../harness/plugin-flow"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await step("start isolated daemon and configure scripted providers", () => startStack({ label: "h15-codex-brokered" }))
  const mcp = await step("start proof MCP server", () => startScriptedMcpServer())
  try {
    const personalConfigPath = path.join(stack.dataDir, ".codex", "config.toml")
    await fs.mkdir(path.dirname(personalConfigPath), { recursive: true })
    await fs.writeFile(personalConfigPath, '# H15 personal configuration\nmodel = "gpt-5.5"\n')
    const personalConfig = await fs.readFile(personalConfigPath)
    const applied = await step("apply signed plugin generation", () => applyScriptedPluginProfile(stack.url, { harnessIds: ["codex"], servers: { proof: { type: "streamable-http", url: mcp.url } } }))
    assert.equal(applied.active, true)
    assert.deepEqual(await fs.readFile(personalConfigPath), personalConfig, "plugin activation changed the person's Codex config")
    const api = new ClaxedoApi(stack.url)
    const workspace = await step("register the workspace", () => stack.daemon.makeWorkspace("h15-codex-brokered"))
    const stream = await step("open the workspace event stream", () => stack.events(workspace.directory))
    const model = { providerId: "codex", modelId: "gpt-5.5" }
    const session = await step("create native session", () => api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, model, title: "H15 Codex brokered plugin", permissionMode: "full-access",
    }))
    stack.scripted.scriptTool({ name: "tool_search", format: "tool_search", input: { query: "proof" }, whenPromptIncludes: "H15CODEXINIT" })
    await step("complete the brokered Codex tool-discovery prompt HTTP response", () => api.prompt(workspace.directory, session.id, "Inspect the installed plugin H15CODEXINIT", { model }))
    await step("observe probe session idle", () => stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "brokered Codex plugin probe idle", timeoutMs: 60_000 }))
    await step("read the shared Codex plugin profile", () => sharedCodexProfileConfig(stack.dataDir))
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, "H-4: brokered Codex's tool_search loaded no projected plugin proof tool")
    stack.scripted.scriptTool({ ...tool.call, input: { marker: "H15CODEX" }, whenPromptIncludes: "H15CODEX" })
    await step("complete the brokered Codex proof-tool prompt HTTP response", () => api.prompt(workspace.directory, session.id, "Use the installed plugin proof tool with marker H15CODEX", { model }))
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H15CODEX"), "H-4: brokered Codex did not call the projected plugin proof tool")
    const toolParts = (await step("read session messages", () => api.messages(workspace.directory, session.id))).flatMap((message) => message.parts).filter((part) => part.type === "tool")
    assert.ok(toolParts.some((part) => JSON.stringify(part.state).includes("MCP_PROOF:H15CODEX")), `the MCP proof result was not stored: ${JSON.stringify(toolParts)}`)
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("MCP_PROOF:H15CODEX")), "the MCP proof result never reached the model")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await step("read session state", () => api.session(workspace.directory, session.id))).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    assert.deepEqual(await fs.readFile(personalConfigPath), personalConfig, "the Codex session changed the person's config")
    console.log("H15 Codex brokered: projected plugin tool executed through the Codex app server")
  } finally {
    await step("close proof MCP server", () => mcp.close())
    await step("close the isolated stack", () => stack.close())
  }
}
