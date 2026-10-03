import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { applyScriptedPluginProfile, scriptedPluginServerName } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"
import { directTransport, sendJson } from "../harness/transport"

type Command = { name: string; content?: string; origin: "saved" | "transport" }
type McpServer = { name: string; url?: string }

export async function run() {
  const mcp = await startScriptedMcpServer()
  try {
    const stack = await startStack({ label: "h33-local-machine-config" })
    try {
      const workspace = await stack.daemon.makeWorkspace("h33-local")
      const api = new ClaxedoApi(stack.url)
      const configUrl = `${stack.url}/api/claxedo/agent-config`
      const commandsUrl = `${stack.url}/command?directory=${encodeURIComponent(workspace.directory)}&connectionId=${SCRIPTED_ACP_HARNESS.id}`
      const stream = await stack.events(workspace.directory)
      const warm = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await stack.acp.write("h33-installed", { steps: [{ kind: "prompt" }, { kind: "mcp", marker: "H33LOCAL" }] })
      const content = `Saved command delivered to the machine runtime. ${acpScriptToken("h33-installed")}`
      await sendJson(directTransport, "POST", `${configUrl}/commands`, { name: "machine-proof", content }, "H33 save command")
      const commands = JSON.parse(await sendJson(directTransport, "GET", commandsUrl, undefined, "H33 machine command list")) as Command[]
      const saved = commands.find((command) => command.name === "machine-proof" && command.origin === "saved")
      assert.equal(saved?.content, content, "C-7: saved command never reached the running machine runtime")
      const installed = await applyScriptedPluginProfile(stack.url, {
        harnessIds: ["acp"], servers: { scripted: { type: "streamable-http", url: mcp.url } },
      })
      assert.equal(installed.active, true)
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, saved.content, { title: true })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H33 local plugin turn" })
      assert.equal(frameType(settled), "session.idle", `C-7: machine plugin turn failed: ${JSON.stringify(settled)}`)
      await waitForTitle(stream, session.id)
      assert.deepEqual(mcp.calls, [{ name: "proof", arguments: { marker: "H33LOCAL" } }], "C-7: installed plugin never reached the machine session")
      const history = assistantText(await api.messages(workspace.directory, session.id))
      assert.match(history, /Saved command delivered to the machine runtime/)
      assert.match(history, /MCP_PROOF:H33LOCAL/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
      const started = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new").at(-1)
      assert.ok(started, "installed plugin session never reached ACP session/new")
      assert.ok((started.params.mcpServers as McpServer[]).some((server) => scriptedPluginServerName("scripted").test(server.name) && server.url === mcp.url))

      await sendJson(directTransport, "DELETE", `${configUrl}/commands/machine-proof`, undefined, "H33 remove command")
      const removed = JSON.parse(await sendJson(directTransport, "GET", commandsUrl, undefined, "H33 commands after removal")) as Command[]
      assert.ok(!removed.some((command) => command.name === "machine-proof"), "C-7: deleted command remains in the machine runtime")
      assert.ok(removed.some((command) => command.origin === "transport"), "removal dropped transport-declared commands")
      await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/plugins/signed-runtime`, null, "H33 remove plugin")
      await stack.acp.write("h33-removed", { steps: [{ kind: "text", text: "H33_REMOVED" }] })
      const after = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, after.id, acpScriptToken("h33-removed"), { title: true })
      await stream.waitFor((frame) => frameSessionId(frame) === after.id && frameType(frame) === "session.idle", { label: "H33 local removal turn" })
      await waitForTitle(stream, after.id)
      const restarted = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new").at(-1)
      assert.ok(restarted, "plugin removal session never reached ACP session/new")
      assert.ok(!(restarted.params.mcpServers as McpServer[]).some((server) => scriptedPluginServerName("scripted").test(server.name)),
        "C-7: removed plugin still reaches new sessions in the machine runtime")
      assert.match(assistantText(await api.messages(workspace.directory, after.id)), /H33_REMOVED/)
      assert.equal((await api.session(workspace.directory, warm.id)).id, warm.id, "config changes dropped a session the runtime already held")
      assert.deepEqual(stack.egress.attempts, [])
    } finally { await stack.close() }
  } finally { await mcp.close() }
}
