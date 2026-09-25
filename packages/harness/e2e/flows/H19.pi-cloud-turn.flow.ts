import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { activateCloudCredential, cloudSessionTransport, createCloudWorkspace, setCloudCredentialScope, waitCloudConnection, reachCloudRuntime } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"
import { frameType, openEventStream } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h19-cloud-pi", cloud: true })
  try {
    await activateCloudCredential(stack, await setCloudCredentialScope(stack, "openai", "shared"))
    const workspace = await createCloudWorkspace(stack, "h19-pi")
    const connection = await waitCloudConnection(stack, workspace.id)
    assert.equal(connection.status, 200, `Cloud connection: ${connection.body}`)
    const api = new ClaxedoApi(stack.url, cloudSessionTransport(stack, workspace.id), { reserveSessions: true })
    const stream = await reachCloudRuntime(openEventStream(stack.url, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${stack.daemon.cloudToken}`,
    }))
    try {
      const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
      const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
      await api.prompt(workspace.directory, session.id, "Reply with CLOUDPITURN", { model })
      await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "cloud Pi idle" })
      const messages = await api.messages(workspace.directory, session.id)
      if (!assistantText(messages).includes("CLOUDPITURN")) {
        throw new Error(`C-15: signed cloud Pi turn had no usable owner credential; messages: ${JSON.stringify(messages)}`)
      }
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud Pi emitted no live text frame")
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("CLOUDPITURN")), "cloud Pi never reached scripted model")
      assert.deepEqual(stack.egress.attempts, [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
