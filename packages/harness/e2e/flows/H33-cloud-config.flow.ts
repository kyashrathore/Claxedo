import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { cloudRuntimeUrl, cloudApi, cloudSessionTransport, cloudTransport, createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { applyScriptedPluginProfile, scriptedPluginServerName } from "../harness/scripted-plugin-profile"
import { startScriptedMcpServer } from "../harness/scripted-mcp-server"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"
import { sendJson } from "../harness/transport"

type Command = { name: string; content?: string; origin: "saved" | "transport" }
type McpServer = { name: string; url?: string }

export async function run() {
  const mcp = await startScriptedMcpServer()
  try {
    const stack = await startStack({ label: "h33-cloud-config", cloud: true, cloudMcpUrl: mcp.url })
    try {
      const workspace = await createCloudWorkspace(stack, "h33")
      const connected = await waitCloudConnection(stack, workspace.id)
      assert.equal(connected.status, 200, `H33 cloud connection: ${connected.body}`)
      const original = await cloudRuntimeUrl(stack, workspace.id)
      const control = cloudTransport(stack)
      const runtime = cloudSessionTransport(stack, workspace.id)
      const configUrl = `${stack.url}/api/claxedo/agent-config`
      await sendJson(control, "POST", `${configUrl}/harness`, { harness: { kind: "native", harnessId: "pi" } }, "H33 first default")
      await sendJson(control, "POST", `${configUrl}/harness`, {
        harness: { kind: "connection", connectionId: SCRIPTED_ACP_HARNESS.id },
      }, "H33 changed default")
      const health = JSON.parse(await sendJson(runtime, "GET", `${stack.url}/api/wr/health`, undefined, "H33 runtime health")) as { harness?: unknown }
      assert.deepEqual(health.harness, { kind: "connection", connectionId: SCRIPTED_ACP_HARNESS.id }, "C-7: changed default never reached the running sandbox")
      await stack.acp.write("h33-installed", { steps: [{ kind: "prompt" }, { kind: "mcp", marker: "H33CLOUD" }] })
      const content = `Saved command delivered to cloud. ${acpScriptToken("h33-installed")}`
      await sendJson(control, "POST", `${configUrl}/commands`, { name: "cloud-proof", content }, "H33 save command")
      const commandsUrl = `${stack.url}/command?directory=${encodeURIComponent(workspace.directory)}`
      const commands = JSON.parse(await sendJson(runtime, "GET", commandsUrl, undefined, "H33 cloud command list")) as Command[]
      const saved = commands.find((command) => command.name === "cloud-proof" && command.origin === "saved")
      assert.equal(saved?.content, content, "C-7: saved command never reached the running sandbox")
      const installed = await applyScriptedPluginProfile(stack.url, {
        harnessIds: ["acp"], servers: { scripted: { type: "streamable-http", url: mcp.url } },
      }, control)
      assert.equal(installed.active, true)
      const api = cloudApi(stack, workspace.id)
      const stream = await openEventStream(stack.url, workspace.directory, {
        relayWorkspaceId: workspace.id, authorization: `Bearer ${stack.daemon.cloudToken}`,
      })
      try {
        const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
        await api.prompt(workspace.directory, session.id, saved.content)
        const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
          (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H33 plugin turn" })
        assert.equal(frameType(settled), "session.idle", `C-7: cloud plugin turn failed: ${JSON.stringify(settled)}`)
        assert.deepEqual(mcp.calls, [{ name: "proof", arguments: { marker: "H33CLOUD" } }], "C-7: installed plugin never reached the cloud session")
        const history = assistantText(await api.messages(workspace.directory, session.id))
        assert.match(history, /Saved command delivered to cloud/)
        assert.match(history, /MCP_PROOF:H33CLOUD/)
        assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
        assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
        const starts = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new")
        const started = starts.at(-1)
        assert.ok(started, "installed plugin session never reached ACP session/new")
        const servers = started.params.mcpServers as McpServer[]
        assert.ok(servers.some((server) => scriptedPluginServerName("scripted").test(server.name) && server.url === mcp.url))
        await sendJson(control, "DELETE", `${configUrl}/commands/cloud-proof`, undefined, "H33 remove command")
        const removed = JSON.parse(await sendJson(runtime, "GET", commandsUrl, undefined, "H33 commands after removal")) as Command[]
        assert.ok(!removed.some((command) => command.name === "cloud-proof"), "C-7: deleted command remains in the sandbox")
        assert.ok(removed.some((command) => command.origin === "transport"), "removal dropped transport-declared commands")
        await sendJson(control, "PUT", `${stack.url}/api/claxedo/plugins/signed-runtime`, null, "H33 remove plugin")
        await stack.acp.write("h33-removed", { steps: [{ kind: "text", text: "H33_REMOVED" }] })
        const after = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
        await api.prompt(workspace.directory, after.id, acpScriptToken("h33-removed"))
        await stream.waitFor((frame) => frameSessionId(frame) === after.id && frameType(frame) === "session.idle", { label: "H33 removal turn" })
        const restarted = (await readAcpRequests(stack.acp.scriptDir)).filter((request) => request.method === "session/new").at(-1)
        assert.ok(restarted, "plugin removal session never reached ACP session/new")
        assert.ok(!(restarted.params.mcpServers as McpServer[]).some((server) => scriptedPluginServerName("scripted").test(server.name)),
          "C-7: removed plugin still reaches new sessions in the running sandbox")
        assert.match(assistantText(await api.messages(workspace.directory, after.id)), /H33_REMOVED/)
        assert.equal((await cloudRuntimeUrl(stack, workspace.id)).pid, original.pid, "config changes restarted the cloud runtime")
        assert.deepEqual(stack.egress.attempts, [])
      } finally { stream.close() }
    } finally { await stack.close() }
  } finally { await mcp.close() }
}
