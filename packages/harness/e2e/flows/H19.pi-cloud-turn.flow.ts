import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { hostedWorkspace } from "../harness/hosted-flow"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedMachineFile, hostedPiSession, hostedSessionHostRoot, startHostedCloudStack } from "../harness/hosted-cloud"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startHostedCloudStack("h19-cloud-pi")
  try {
    const stored = await hostedFetch(stack, "/api/claxedo/credentials", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "managed", label: "OpenAI", secret: "test-key" }),
    }, stack.owner)
    assert.equal(stored.status, 200, `Storing the signed Pi account: ${await stored.text()}`)
    const workspace = await hostedWorkspace(stack, stack.owner, "h19-pi")
    const session = await hostedPiSession(stack, stack.owner, workspace, { providerId: "pi", modelId: "openai/gpt-4.1" })
    assert.equal(session.connection.backing, "durable-object")
    assert.equal(session.connection.hostId, `session-do:${session.sessionId}`)
    assert.equal((await session.create()).id, session.sessionId)
    const stream = await session.events()
    try {
      stack.model.scriptTool({ name: "write", input: { path: "cloud-pi.txt", content: "written from the session host" }, whenPromptIncludes: "CLOUDPITURN" })
      await session.prompt("Write the file, then reply with exactly this one token: CLOUDPITURN")
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.sessionId
        && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "cloud Pi settlement", timeoutMs: 60_000 })
      assert.equal(frameType(settled), "session.idle", `Cloud Pi turn failed before idle: ${JSON.stringify(settled)}; model requests: ${stack.model.requests.length}`)
      await waitForTitle(stream, session.sessionId)
      const messages = await session.messages()
      assert.ok(assistantText(messages).includes("CLOUDPITURN"), `the transcript read through the session host: ${JSON.stringify(messages)}`)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated"), "cloud Pi emitted no live part frame")
      const file = await hostedMachineFile(stack, workspace, "cloud-pi.txt")
      assert.equal(file.status, 200, `the machine's file route: ${JSON.stringify(file.body)}`)
      assert.equal(file.body.content, "written from the session host")
      assert.equal(await hostedSessionHostRoot(stack, stack.owner, workspace.id, session.sessionId), session.sessionId)
      assert.ok(stack.model.requests.some((request) => request.prompt.includes("CLOUDPITURN") && request.authorization === "Bearer test-key"),
        "cloud Pi never reached the scripted model with the owner's own key")
      assert.deepEqual(await stack.outboundAttempts(), [])
    } finally {
      stream.close()
    }
  } finally {
    await stack.close()
  }
}
