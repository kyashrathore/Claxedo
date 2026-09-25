import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS, SCRIPTED_ACP_WEBSOCKET_HARNESS, scriptedAcpWebSocketConnection } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken } from "../harness/acp/script"
import { startScriptedAcpWebSocket } from "../harness/acp/websocket"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport, sendJson } from "../harness/transport"

export async function run() {
  const stack = await startStack({ label: "h16-custom-acp" })
  const remote = await startScriptedAcpWebSocket(stack.acp.scriptDir, { dropMethod: process.env.H16_DROP_METHOD })
  try {
    await sendJson(directTransport, "PUT", `${stack.url}/api/claxedo/agent-config/connections/${SCRIPTED_ACP_WEBSOCKET_HARNESS.id}`,
      scriptedAcpWebSocketConnection(remote.url), "H16 websocket connection")
    const api = new ClaxedoApi(stack.url)
    await stack.acp.write("h16-turn", { steps: [{ kind: "text", text: "H16 scripted reply" }] })
    for (const [label, harness] of [["command", SCRIPTED_ACP_HARNESS], ["websocket", SCRIPTED_ACP_WEBSOCKET_HARNESS]] as const) {
      const workspace = await stack.daemon.makeWorkspace(`h16-${label}`)
      await api.setHarness(workspace.directory, { kind: "connection", connectionId: harness.id })
      const stream = await stack.events(workspace.directory)
      const session = await api.createSession(workspace.directory, { harness, title: `H16 ${label}` })
      await assert.doesNotReject(api.prompt(workspace.directory, session.id, acpScriptToken("h16-turn")), `${label} ACP prompt must complete across its transport`)
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: `${label} idle` })
      assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H16 scripted reply/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id), `${label} emitted no live part`)
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      const fork = await fetch(`${stack.url}/session/${session.id}/fork?directory=${encodeURIComponent(workspace.directory)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      })
      if (!fork.ok) throw new Error(`${label} fork refused: ${fork.status} ${await fork.text()}`)
      const child = await fork.json() as { id: string }
      assert.equal((await api.session(workspace.directory, child.id)).id, child.id)
      const agents = await fetch(`${stack.url}/agent?directory=${encodeURIComponent(workspace.directory)}`).then((response) => response.json()) as Array<{ name: string }>
      assert.ok(Array.isArray(agents) && agents.some((agent) => agent.name === "review"), `${label} agent list omitted review: ${JSON.stringify(agents)}`)
      const commands = (await api.session(workspace.directory, session.id)).commands as Array<{ name: string }> | undefined
      assert.ok(commands?.some((command) => command.name === "scripted"), `${label} session commands omitted scripted: ${JSON.stringify(commands)}`)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "session.commands" && frameSessionId(frame) === session.id), `${label} emitted no live session.commands`)
      console.log(`H16 ${label}: live frame, stored reply, session/fork readback, agents and commands passed`)
    }
    const requests = await readAcpRequests(stack.acp.scriptDir)
    assert.ok(requests.some((request) => request.method === "session/fork"), "agent saw no fork request")
    assert.equal(stack.egress.attempts.length, 0)
  } finally {
    await remote.close()
    await stack.close()
  }
}
