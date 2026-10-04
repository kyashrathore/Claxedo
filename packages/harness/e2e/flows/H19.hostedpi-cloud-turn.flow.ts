import assert from "node:assert/strict"
import { assistantText } from "../harness/api"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedPiSession, hostedSessionHostRoot } from "../harness/hosted-cloud"
import { hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startHostedStack("h19-hosted-pi")
  try {
    const owner = await hostedOwner(stack)
    const stored = await hostedFetch(stack, "/api/claxedo/credentials", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "openai", kind: "api_key", source: "managed", label: "OpenAI", secret: "hosted-owner-openai-key" }),
    }, owner)
    assert.equal(stored.status, 200, `hosted Pi credential: ${await stored.text()}`)
    const workspace = await hostedWorkspace(stack, owner, "H19 hosted Pi")
    const session = await hostedPiSession(stack, owner, workspace, { providerId: "pi", modelId: "openai/gpt-4.1" })
    await session.create()
    const stream = await session.events()
    try {
      for (const token of ["HOSTEDPITURN", "HOSTEDPIAGAIN"]) {
        const before = stream.frames.length
        await session.prompt(`Reply with exactly this one token: ${token}`)
        const settled = await stream.waitFor((frame) => stream.frames.indexOf(frame) >= before && frameSessionId(frame) === session.sessionId
          && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: `hosted Pi ${token}`, timeoutMs: 60_000 })
        assert.equal(frameType(settled), "session.idle", `hosted Pi ${token} failed: ${JSON.stringify(settled)}`)
      }
      const text = assistantText(await session.messages())
      assert.ok(text.includes("HOSTEDPITURN") && text.includes("HOSTEDPIAGAIN"), `the session host's transcript: ${text}`)
      const spent = new Set(stack.model.requests.filter((request) => request.prompt.includes("HOSTEDPI")).map((request) => request.authorization))
      assert.deepEqual(spent, new Set(["Bearer hosted-owner-openai-key"]), "the session host spent anything but the owner's own key")
      assert.equal(await hostedSessionHostRoot(stack, owner, workspace.id, session.sessionId), session.sessionId)
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H19.hostedpi refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
