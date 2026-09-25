import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { cloudAcpScript } from "../harness/cloud-faults"
import { cloudSessionTransport, createCloudWorkspace, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"
import { frameType, openEventStream } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h19-cloud-acp", cloud: true })
  try {
    await stack.acp.write("h19-cloud", cloudAcpScript({ steps: [{ kind: "text", text: "H19_CLOUD_ACP" }] }, process.env.CLAXEDO_E2E_CLOUD_FAULT))
    const workspace = await createCloudWorkspace(stack, "h19-acp")
    const connection = await waitCloudConnection(stack, workspace.id)
    assert.equal(connection.status, 200, `Cloud connection: ${connection.body}`)
    const runtimeHealth = `${stack.url}/workspaces/${encodeURIComponent(workspace.id)}/api/wr/health`
    const unsigned = await fetch(runtimeHealth)
    assert.ok(unsigned.status >= 400, `unsigned caller reached owner's runtime: ${unsigned.status}`)
    const ungranted = await fetch(runtimeHealth, { headers: { authorization: `Bearer ${stack.daemon.cloudMemberToken}` } })
    assert.ok(ungranted.status >= 400, `ungranted member reached owner's runtime: ${ungranted.status}`)
    const api = new ClaxedoApi(stack.url, cloudSessionTransport(stack, workspace.id), { reserveSessions: true })
    const stream = await openEventStream(stack.url, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${stack.daemon.cloudToken}`,
    })
    try {
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, `Reply ${acpScriptToken("h19-cloud")}`)
      await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "cloud ACP idle" })
      const messages = await api.messages(workspace.directory, session.id)
      assert.match(assistantText(messages), /H19_CLOUD_ACP/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud ACP emitted no live text frame")
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.deepEqual(stack.egress.attempts, [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
