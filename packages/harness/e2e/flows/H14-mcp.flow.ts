import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { applyScriptedPluginProfile, scriptedPluginServerName } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

type CatalogTarget = { id: string; label: string; delivery: { wholePlugins: unknown; mcpServers: boolean } }

export async function run() {
  const stack = await startStack({ label: "h14-mcp" })
  const mcp = await startScriptedMcpServer()
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h14-mcp")
    const applied = await applyScriptedPluginProfile(stack.url, {
      harnessIds: ["acp", "claude"],
      servers: { scripted: { type: "streamable-http", url: mcp.url } },
    })
    assert.equal(applied.active, true)
    const catalog = JSON.parse(await sendJson(directTransport, "GET", `${stack.url}/api/claxedo/plugins`, undefined, "plugin catalog")) as { harnessTargets: CatalogTarget[] }
    const acpTarget = catalog.harnessTargets.find((target) => target.id === "acp")
    assert.deepEqual(acpTarget?.delivery.wholePlugins, { reach: "one-agent", agent: "@agentclientprotocol/claude-agent-acp" }, "the catalog states what reaches a custom ACP agent")
    if (process.env.CLAXEDO_E2E_REFUSE_MCP_TOOL === "1") mcp.refuseToolCalls()
    await stack.acp.write("h14-acp", { steps: [{ kind: "mcp", marker: "H14ACP" }] })
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H14 MCP ACP" })
    await api.prompt(workspace.directory, session.id, `Call the plugin's MCP tool. ${acpScriptToken("h14-acp")}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "MCP ACP turn idle" })
    assert.deepEqual(mcp.calls, [{ name: "proof", arguments: { marker: "H14ACP" } }])
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H14ACP/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    const started = (await readAcpRequests(stack.acp.scriptDir)).find((request) => request.method === "session/new" && request.params.cwd === workspace.directory)
    const servers = started?.params.mcpServers as Array<{ name: string; url?: string }> | undefined
    assert.ok(servers?.some((server) => scriptedPluginServerName("scripted").test(server.name) && server.url === mcp.url),
      `session/new carried no plugin MCP server: ${JSON.stringify(servers)}`)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log("H14 ACP: the plugin's HTTP MCP tool reached the real ACP process at session/new, was called, stored, streamed, and read back")

    const claudeStream = await stack.events(workspace.directory)
    const claude = await api.createSession(workspace.directory, {
      harness: { id: "claude", access: "native" }, title: "H14 MCP Claude", permissionMode: "bypassPermissions",
      model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
    })
    await api.prompt(workspace.directory, claude.id, "Inspect the enabled plugin tools H14CLAUDEINIT", {
      model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
    })
    await claudeStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === claude.id, { label: "MCP Claude probe idle", timeoutMs: 60_000 })
    const tool = stack.scripted.requests.flatMap((request) => request.tools).find((item) => item.name.includes("proof") && item.name.startsWith("mcp__"))
    assert.ok(tool, `Claude advertised no plugin MCP proof tool: ${JSON.stringify(stack.scripted.requests.flatMap((request) => request.tools.map((item) => item.name)))}`)
    stack.scripted.scriptTool({ name: tool.name, input: { marker: "H14CLAUDE" }, whenPromptIncludes: "H14CLAUDE" })
    await api.prompt(workspace.directory, claude.id, "Call the plugin MCP proof tool with marker H14CLAUDE", {
      model: { providerId: "claude", modelId: "claude-sonnet-4-6" },
    })
    assert.ok(mcp.calls.some((call) => call.arguments.marker === "H14CLAUDE"), `Claude did not call MCP; stored: ${JSON.stringify(await api.messages(workspace.directory, claude.id)).slice(-1200)}`)
    assert.equal((await api.session(workspace.directory, claude.id)).id, claude.id)
    console.log("H14 Claude: the same plugin's MCP tool called through the Claude SDK")

    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "MCP flow made an unexpected outbound request")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
