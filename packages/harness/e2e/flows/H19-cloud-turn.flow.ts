import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { cloudAcpScript } from "../harness/cloud-faults"
import { hostedApi, hostedWorkspace } from "../harness/hosted-flow"
import { hostedFetch, signInHostedPerson } from "../harness/hosted-auth"
import { startHostedCloudStack } from "../harness/hosted-cloud"
import { frameType, openEventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startHostedCloudStack("h19-cloud-acp")
  try {
    await stack.acp.write("h19-cloud", cloudAcpScript({ steps: [{ kind: "text", text: "H19_CLOUD_ACP" }] }, process.env.CLAXEDO_E2E_CLOUD_FAULT))
    const workspace = await hostedWorkspace(stack, stack.owner, "h19-acp")
    const connection = await hostedFetch(stack, `/api/workspace/${workspace.id}/connection`, {}, stack.owner)
    assert.equal(connection.status, 200, `Cloud connection: ${await connection.text()}`)
    const runtimeHealth = `${stack.relayUrl}/workspaces/${encodeURIComponent(workspace.id)}/api/wr/health`
    const unsigned = await fetch(runtimeHealth)
    assert.ok(unsigned.status >= 400, `unsigned caller reached owner's runtime: ${unsigned.status}`)
    const member = await signInHostedPerson(stack, "hosted-person-b")
    const ungrantedConnection = await hostedFetch(stack, `/api/workspace/${workspace.id}/connection`, {}, member)
    assert.ok(ungrantedConnection.status >= 400, `ungranted member received a runtime capability: ${ungrantedConnection.status}`)
    const ungranted = await fetch(runtimeHealth, { headers: { cookie: member.cookie } })
    assert.ok(ungranted.status >= 400, `ungranted member reached owner's runtime: ${ungranted.status}`)
    const api = hostedApi(stack, workspace, stack.owner)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, `Reply ${acpScriptToken("h19-cloud")}`, { title: true })
      await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "cloud ACP idle" })
      await waitForTitle(stream, session.id)
      const messages = await api.messages(workspace.directory, session.id)
      assert.match(assistantText(messages), /H19_CLOUD_ACP/)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud ACP emitted no live text frame")
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.deepEqual(await stack.outboundAttempts(), [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
