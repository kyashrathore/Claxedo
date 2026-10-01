import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { hostedApi, hostedWorkspace } from "../harness/hosted-flow"
import { hostedFetch } from "../harness/hosted-auth"
import { startHostedCloudStack } from "../harness/hosted-cloud"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"
import { sendJson } from "../harness/transport"

export async function run() {
  const stack = await startHostedCloudStack("h19-cloud-pi")
  try {
    const stored = await sendJson(stack.control, "PUT", `${stack.workerUrl}/api/claxedo/credentials`, {
      provider_id: "openai", kind: "api_key", source: "managed", scope: "shared", secret: "test-key",
    }, "Storing the signed Pi account")
    await sendJson(stack.control, "POST", `${stack.workerUrl}/api/claxedo/credentials/activate`, { ids: [(JSON.parse(stored) as { credential: { id: string } }).credential.id] }, "Activating cloud credential")
    const workspace = await hostedWorkspace(stack, stack.owner, "h19-pi")
    const connection = await hostedFetch(stack, `/api/workspace/${workspace.id}/connection`, {}, stack.owner)
    assert.equal(connection.status, 200, `Cloud connection: ${await connection.text()}`)
    const api = hostedApi(stack, workspace, stack.owner)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id,
      authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
      const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
      await api.prompt(workspace.directory, session.id, "Reply with exactly this one token: CLOUDPITURN", { model, title: true })
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id
        && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "cloud Pi settlement", timeoutMs: 60_000 })
      assert.equal(frameType(settled), "session.idle", `Cloud Pi turn failed before idle: ${JSON.stringify(settled)}; model requests: ${stack.model.requests.length}`)
      await waitForTitle(stream, session.id)
      const messages = await api.messages(workspace.directory, session.id)
      if (!assistantText(messages).includes("CLOUDPITURN")) {
        throw new Error(`C-15: signed cloud Pi turn had no usable owner credential; messages: ${JSON.stringify(messages)}`)
      }
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud Pi emitted no live text frame")
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      assert.ok(stack.model.requests.some((request) => request.prompt.includes("CLOUDPITURN")), "cloud Pi never reached scripted model")
      assert.deepEqual(await stack.outboundAttempts(), [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
