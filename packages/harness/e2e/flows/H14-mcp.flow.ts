import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h14-mcp" })
  const mcp = await startScriptedMcpServer()
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h14-mcp")
    await api.configureMcp("scripted", mcp.url)
    assert.deepEqual(await api.mcpConfig(), { scripted: { type: "remote", url: mcp.url, headers: {} } })
    await stack.daemon.restart()
    if (process.env.CLAXEDO_E2E_REFUSE_MCP_TOOL === "1") mcp.refuseToolCalls()
    await stack.acp.write("h14-acp", { steps: [{ kind: "mcp", marker: "H14ACP" }] })
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H14 MCP ACP" })
    await api.prompt(workspace.directory, session.id, `Call the configured MCP tool. ${acpScriptToken("h14-acp")}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "MCP ACP turn idle" })
    assert.deepEqual(mcp.calls, [{ name: "proof", arguments: { marker: "H14ACP" } }])
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H14ACP/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H14 ACP: configured HTTP MCP tool was called by the real ACP process, stored, streamed, and read back")

    const claudeStream = await stack.events(workspace.directory)
    const claude = await api.createSession(workspace.directory, {
      harness: { id: "claude", access: "native" }, title: "H14 MCP Claude", permissionMode: "bypassPermissions",
      model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
    })
    stack.scripted.scriptTool({ name: "mcp__scripted__proof", input: { marker: "H14CLAUDE" }, whenPromptIncludes: "H14CLAUDE" })
    await api.prompt(workspace.directory, claude.id, "Call the scripted MCP proof tool with marker H14CLAUDE", {
      model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
    })
    await claudeStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === claude.id, { label: "MCP Claude turn idle", timeoutMs: 60_000 })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H14CLAUDE"), `Claude did not call MCP; advertised scripted tools: ${JSON.stringify(stack.scripted.requests.flatMap((request) => request.tools.map((tool) => tool.name)).filter((name) => name.includes("scripted")))}; stored: ${JSON.stringify(await api.messages(workspace.directory, claude.id)).slice(-1200)}`)
    assert.equal((await api.session(workspace.directory, claude.id)).id, claude.id)
    console.log("H14 Claude: configured HTTP MCP tool called through the Claude SDK")

    const codexStream = await stack.events(workspace.directory)
    const codex = await api.createSession(workspace.directory, {
      harness: { id: "codex", access: "native" }, title: "H14 MCP Codex", permissionMode: "full-access",
      model: { providerId: "codex", modelId: "gpt-5.5" },
    })
    stack.scripted.scriptTool({ name: "mcp__scripted__proof", input: { marker: "H14CODEX" }, whenPromptIncludes: "H14CODEX" })
    await api.prompt(workspace.directory, codex.id, "Call the scripted MCP proof tool with marker H14CODEX", {
      model: { providerId: "codex", modelId: "gpt-5.5" },
    })
    await codexStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === codex.id, { label: "MCP Codex turn idle", timeoutMs: 60_000 })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H14CODEX"), `Codex did not call MCP; MCP calls: ${JSON.stringify(mcp.calls)}; requests: ${JSON.stringify(mcp.methods)}; response tools: ${JSON.stringify(stack.scripted.requests.filter((request) => request.dialect === "responses").map((request) => request.tools.map((tool) => tool.name)))}`)
    assert.equal((await api.session(workspace.directory, codex.id)).id, codex.id)
    console.log("H14 Codex: configured HTTP MCP tool called through the Codex app server")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
