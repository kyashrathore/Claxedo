import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { scriptedAcpWebSocketConnection } from "../harness/acp/connection"
import { readAcpRequests, type RecordedAcpRequest } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { startScriptedAcpWebSocket } from "../harness/acp/websocket"
import { applyScriptedPluginProfile, scriptedPluginServerName } from "../harness/scripted-plugin-profile"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

type McpEntry = { name?: string; type?: string; url?: string; headers?: unknown }

function assertNoRemoteLeaks(requests: RecordedAcpRequest[], method: string, label: string): Error[] {
  const call = requests.find((request) => request.method === method && request.source === label)
  assert.ok(call, `${label}: remote agent received no ${method}`)
  const servers = call.params.mcpServers as McpEntry[] | undefined
  assert.ok(Array.isArray(servers), `${label}: ${method} omitted mcpServers`)
  assert.ok(servers.some((server) => scriptedPluginServerName("h24_http").test(server.name ?? "") && server.type === "http"), `${label}: ${method} omitted the plugin's HTTP MCP server`)
  assert.equal(call.authorization, null, `${label}: ${method} carried a websocket Authorization header`)
  const errors: Error[] = []
  const check = (condition: boolean, message: string) => { if (!condition) errors.push(new Error(message)) }
  const firstParty = servers.filter((server) => server.name === "claxedo" || server.url?.includes("/api/claxedo/mcp"))
  check(firstParty.length === 0, `H-1: ${label}: ${method} leaked first-party Claxedo MCP server`)
  const bearer = firstParty.some((server) => JSON.stringify(server.headers).toLowerCase().includes("authorization"))
  check(!bearer, `H-1: ${label}: ${method} leaked first-party MCP Authorization`)
  check(!servers.some((server) => server.type === "stdio" || "command" in server), `H-2: ${label}: ${method} leaked stdio MCP server`)
  return errors
}

export async function run() {
  const stack = await startStack({ label: "h24-remote-acp" })
  const remotes = [] as Array<Awaited<ReturnType<typeof startScriptedAcpWebSocket>>>
  try {
    await applyScriptedPluginProfile(stack.url, {
      harnessIds: ["acp"],
      servers: {
        h24_local: { type: "stdio", command: "h24-local-command" },
        h24_http: { type: "streamable-http", url: "https://mcp.example.test/h24" },
      },
    })
    await stack.acp.write("h24-turn", { steps: [{ kind: "text", text: "H24 remote reply" }] })
    const api = new ClaxedoApi(stack.url)
    const errors: Error[] = []
    for (const restoreMode of ["load", "resume"] as const) {
      const remote = await startScriptedAcpWebSocket(stack.acp.scriptDir, { restoreMode, source: restoreMode })
      remotes.push(remote)
      const connectionId = `h24-acp-${restoreMode}`
      await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/agent-config/connections/${connectionId}`,
        scriptedAcpWebSocketConnection(remote.url, {}, connectionId), `H24 ${restoreMode} connection`)
      const workspace = await stack.daemon.makeWorkspace(`h24-${restoreMode}`)
      const harness = { id: connectionId, access: "connection" as const }
      const stream = await stack.events(workspace.directory)
      const session = await api.createSession(workspace.directory, { harness, title: `H24 ${restoreMode}` })
      await api.prompt(workspace.directory, session.id, acpScriptToken("h24-turn"))
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: `H24 ${restoreMode} idle` })
      assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H24 remote reply/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id))
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      const fork = await fetch(`${stack.url}/session/${session.id}/fork?directory=${encodeURIComponent(workspace.directory)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })
      assert.ok(fork.ok, `H24 ${restoreMode} fork refused: ${await fork.text()}`)
      stream.close()
      await stack.daemon.restart()
      await api.prompt(workspace.directory, session.id, acpScriptToken("h24-turn"))
      const requests = await readAcpRequests(stack.acp.scriptDir)
      for (const method of ["session/new", `session/${restoreMode}`, "session/fork"]) errors.push(...assertNoRemoteLeaks(requests, method, restoreMode))
    }
    assert.equal(stack.egress.attempts.length, 0)
    if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"))
    console.log("H24 remote ACP: no first-party MCP bearer or stdio server in new, load, resume and fork")
  } finally {
    for (const remote of remotes) await remote.close()
    await stack.close()
  }
}
