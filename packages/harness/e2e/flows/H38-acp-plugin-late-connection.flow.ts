import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS, scriptedAcpConnection } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { applyScriptedPluginProfile, scriptedPluginServerName } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

const LATE_CONNECTION_ID = "late-acp"

/**
 * Install first, connect later: a plugin activated for custom ACP agents
 * reaches a connection added after the install, because activation resolves
 * when each session starts rather than as a copy made per connection at
 * install time.
 */
export async function run() {
  const stack = await startStack({ label: "h38-late-acp" })
  const mcp = await startScriptedMcpServer()
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h38-late-acp")
    await stack.acp.write("h38-early", { steps: [{ kind: "text", text: "H38 early" }] })
    const earlyStream = await stack.events(workspace.directory)
    const early = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H38 early" })
    await api.prompt(workspace.directory, early.id, acpScriptToken("h38-early"))
    await earlyStream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === early.id, { label: "H38 early idle" })

    const applied = await applyScriptedPluginProfile(stack.url, {
      harnessIds: ["acp"],
      servers: { scripted: { type: "streamable-http", url: mcp.url } },
    })
    assert.equal(applied.active, true)

    const descriptor = { ...scriptedAcpConnection({ bunPath: process.execPath, scriptDir: stack.acp.scriptDir, red: false }), connectionId: LATE_CONNECTION_ID }
    await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/agent-config/connections/${LATE_CONNECTION_ID}`, descriptor, "H38 late connection")
    const stored = JSON.parse(await sendJson(directTransport, "GET", `${stack.url}/api/claxedo/agent-config`, undefined, "H38 config readback")) as { connections: Array<{ connectionId: string; config: unknown }> }
    assert.deepEqual(stored.connections.find((row) => row.connectionId === LATE_CONNECTION_ID)?.config, descriptor.config,
      "the stored connection carries no copy of the plugin's servers")

    await stack.acp.write("h38-late", { steps: [{ kind: "mcp", marker: "H38LATE" }] })
    const stream = await stack.events(workspace.directory)
    const session = await api.createSession(workspace.directory, { harness: { id: LATE_CONNECTION_ID, access: "connection" }, title: "H38 late" })
    await api.prompt(workspace.directory, session.id, `Call the plugin's MCP tool. ${acpScriptToken("h38-late")}`)
    await stream.waitFor((frame) => (frameType(frame) === "session.idle" || frameType(frame) === "session.error") && frameSessionId(frame) === session.id, { label: "H38 late idle" })
    const started = (await readAcpRequests(stack.acp.scriptDir))
      .filter((request) => request.method === "session/new" && request.params.cwd === workspace.directory)
      .at(-1)
    const servers = started?.params.mcpServers as Array<{ name: string; url?: string }> | undefined
    assert.ok(servers?.some((server) => scriptedPluginServerName("scripted").test(server.name) && server.url === mcp.url),
      `the late connection's session/new carried no plugin MCP server: ${JSON.stringify(servers)}`)
    assert.deepEqual(mcp.calls, [{ name: "proof", arguments: { marker: "H38LATE" } }])
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H38LATE/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H38: a connection added after the install received the plugin's MCP server at its first session/new")
  } finally {
    await mcp.close()
    await stack.close()
  }
}
