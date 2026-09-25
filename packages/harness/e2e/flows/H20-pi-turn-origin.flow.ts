import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h20-pi-turn-origin" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h20")
    const ownerDir = path.join(stack.dataDir, ".pi", "agent")
    const legacyDir = path.join(stack.dataDir, "agent-core", workspace.id, "pi", "agent")
    const auth = Buffer.from('{"h20":"owner-login-sentinel"}\n')
    for (const directory of [ownerDir, legacyDir]) {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, "auth.json"), auth)
      await fs.writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: {
        openai: { baseUrl: stack.scripted.v1Url, apiKey: "h20-scripted" },
      } }))
    }
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    await api.promptAsync(workspace.directory, session.id, "Reply with exactly this one token: H20QUEUED")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H20 queued Pi turn" })
    const messages = await api.messages(workspace.directory, session.id)
    assert.match(assistantText(messages), /H20QUEUED/, "H20 queued turn stored answer")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id), "H20 live frame")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id, "H20 session readback")
    assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("H20QUEUED")), "H20 model server readback")
    assert.deepEqual(stack.egress.attempts, [])
    assert.deepEqual(await fs.readFile(path.join(ownerDir, "auth.json")), auth, "H-6: owner Pi login changed")
    assert.deepEqual(await fs.readFile(path.join(legacyDir, "auth.json")), auth, "H-6: current Pi adapter overwrote the owner's profile")
  } finally { await stack.close() }
}
