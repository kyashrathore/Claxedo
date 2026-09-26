import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h15-codex-brokered" })
  const mcp = await startScriptedMcpServer()
  try {
    const applied = await applyScriptedPluginProfile(stack.url, { harnessIds: ["codex"], servers: { proof: { type: "streamable-http", url: mcp.url } } })
    assert.equal(applied.active, true)
    const operatorConfig = await fs.readFile(path.join(stack.dataDir, ".codex", "config.toml"), "utf8")
    assert.match(operatorConfig, /BEGIN CLAXEDO AGENT PLUGINS/, "the Codex profile must first reach the operator home")
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h15-codex-brokered")
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "codex", modelId: "gpt-5.5" }
    const session = await api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, model, title: "H15 Codex brokered plugin", permissionMode: "full-access",
    })
    await api.prompt(workspace.directory, session.id, "Inspect the installed plugin H15CODEXINIT", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "brokered Codex plugin probe idle", timeoutMs: 60_000 })
    const brokeredConfig = await fs.readFile(path.join(stack.dataDir, ".claxedo", "codex", "home", "config.toml"), "utf8")
    assert.match(brokeredConfig, /BEGIN CLAXEDO AGENT PLUGINS/, "H-4: brokered Codex session started without its projected plugin config")
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, "H-4: brokered Codex did not advertise the projected plugin proof tool")
    stack.scripted.scriptTool({ name: tool.name, input: { marker: "H15CODEX" }, whenPromptIncludes: "H15CODEX" })
    await api.prompt(workspace.directory, session.id, "Use the installed plugin proof tool with marker H15CODEX", { model })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H15CODEX"), "H-4: brokered Codex did not call the projected plugin proof tool")
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H15CODEX/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H15 Codex brokered: projected plugin tool executed through the Codex app server")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
