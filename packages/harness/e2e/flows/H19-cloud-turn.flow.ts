import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { activateCloudCredential, cloudRuntimeTransport, cloudRuntimeUrl, createCloudWorkspace, setCloudCredentialScope, waitCloudConnection } from "../harness/cloud-workspace"
import { startStack } from "../harness/stack"
import { frameType, openEventStream, type EventStream } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h19-cloud-pi", cloud: true })
  let stream: EventStream | undefined
  try {
    await activateCloudCredential(stack, await setCloudCredentialScope(stack, "openai", "shared"))
    const workspace = await createCloudWorkspace(stack, "h19-pi")
    const connection = await waitCloudConnection(stack, workspace.id)
    assert.equal(connection.status, 200, `Cloud connection: ${connection.body}\n${stack.daemon.log().split("\n").slice(-15).join("\n")}`)
    const token = (JSON.parse(connection.body) as { runtimeAccessToken?: string }).runtimeAccessToken
    assert.ok(token, "Cloud connection returned no runtime access token")
    const runtime = await cloudRuntimeUrl(stack, workspace.id)
    const api = new ClaxedoApi(stack.url, cloudRuntimeTransport(stack, workspace.id, runtime.url, token), { reserveSessions: true })
    stream = await openEventStream(runtime.url, workspace.directory, { workspaceId: workspace.id, authorization: `Bearer ${token}` })
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    await api.prompt(workspace.directory, session.id, "Reply with CLOUDPITURN", { model })
    await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "cloud Pi idle" })
    const messages = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(messages), /CLOUDPITURN/)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud Pi emitted no live text frame")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("CLOUDPITURN")), "cloud Pi never reached scripted model")
    assert.deepEqual(stack.egress.attempts, [])
  } finally {
    stream?.close()
    await stack.close()
  }
}
