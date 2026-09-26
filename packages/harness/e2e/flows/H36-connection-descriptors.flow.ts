import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { scriptedAcpWebSocketConnection } from "../harness/acp/connection"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { deliveredConnectionDescriptor } from "../harness/connection-revision-fault"

type ProblemReply = { error?: { code?: string }; problems?: Array<{ connectionId: string; problem: string }> }

export async function run() {
  const stack = await startStack({ label: "h36-connections" })
  try {
    const api = new ClaxedoApi(stack.url)
    const endpoint = `${stack.url}/api/claxedo/agent-config/connections`
    const base = scriptedAcpWebSocketConnection("ws://127.0.0.1:47001", {}, "h36-agent")
    const put = async (id: string, body: unknown) => {
      const reply = await directTransport({ method: "PUT", url: `${endpoint}/${encodeURIComponent(id)}`, headers: { "content-type": "application/json" }, body: JSON.stringify(deliveredConnectionDescriptor(id, body)) })
      return { status: reply.status, body: JSON.parse(reply.body) as ProblemReply }
    }
    const refused = async (id: string, body: unknown, reason: RegExp) => {
      const reply = await put(id, body)
      assert.equal(reply.status, 400, JSON.stringify(reply.body))
      assert.equal(reply.body.error?.code, "agent_config_connection_invalid")
      assert.ok(reply.body.problems?.some((problem) => problem.connectionId === id && reason.test(problem.problem)), JSON.stringify(reply.body))
    }

    await refused("Bad/Id", { ...base, connectionId: "Bad/Id" }, /invalid_descriptor|lowercase|slug/)
    await refused("h36-zero", { ...base, connectionId: "h36-zero", configRevision: 0 }, /invalid_descriptor|positive/)
    await refused("h36-unknown", { ...base, connectionId: "h36-unknown", providerKey: "unknown" }, /unknown_provider|not installed/)
    assert.equal((await put("h36-agent", base)).status, 200)
    await refused("h36-agent", { ...base, configRevision: 0 }, /invalid_descriptor|positive/)
    await refused("h36-agent", { ...base, configRevision: 1, config: { ...base.config, label: "Changed" } }, /higher configRevision/)
    await refused("h36-agent", { ...base, configRevision: 2, config: { ...base.config, connection: { kind: "websocket", url: "ws://127.0.0.1:47002" } } }, /immutable_connection_identity|retarget/)
    assert.equal((await put("h36-agent", { ...base, configRevision: 2, config: { ...base.config, label: "Renamed" } })).status, 200)
    const disabled = { ...base, connectionId: "h36-disabled", enabled: false }
    assert.equal((await put("h36-disabled", disabled)).status, 200)
    const workspace = await stack.daemon.makeWorkspace("h36-disabled")
    const createUrl = new URL("/session", stack.url)
    createUrl.searchParams.set("directory", workspace.directory)
    createUrl.searchParams.set("connectionId", "h36-disabled")
    const selection = await directTransport({ method: "POST", url: createUrl.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: { id: "h36-disabled", access: "connection" } }) })
    assert.equal(selection.status, 500, selection.body)
    assert.deepEqual((JSON.parse(selection.body) as { error?: { code?: string; message?: string } }).error,
      { code: "session_create_failed", message: "Connection h36-disabled is disabled" })
    assert.deepEqual(await api.sessions(workspace.directory), [])
    const listing = await directTransport({ method: "GET", url: endpoint })
    assert.equal(listing.status, 200)
    assert.deepEqual((JSON.parse(listing.body) as { connections: Array<{ connectionId: string; label: string }> }).connections.filter((row) => row.connectionId === "h36-agent").map((row) => row.label), ["Renamed"])
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H36: connection route rejected malformed, unknown, stale and retargeted descriptors; label rotation persisted")
  } finally {
    await stack.close()
  }
}
