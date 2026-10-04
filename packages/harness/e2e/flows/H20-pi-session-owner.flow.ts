import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startStack({ label: "h20-pi-session-owner" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h20")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    await api.setPermissionMode(workspace.directory, session.id, "ask")
    stack.scripted.scriptTool({ name: "bash", input: { command: "printf approved > h20.txt" }, whenPromptIncludes: "H20OWNER" })
    await api.promptAsync(workspace.directory, session.id, "Run it, then reply with exactly this one token: H20OWNER")
    await stream.waitFor((frame) => frameType(frame) === "permission.asked" && frameSessionId(frame) === session.id, { label: "H20 Pi asks before bash" })
    const pending = (await api.permissions(workspace.directory)).find((row) => row.sessionID === session.id)
    assert.ok(pending, "H20 Pi's bash permission is listed")
    await api.replyPermission(workspace.directory, session.id, pending.id, "once")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H20 owner turn" })
    await waitForTitle(stream, session.id)
    assert.equal(await fs.readFile(path.join(workspace.directory, "h20.txt"), "utf8"), "approved", "H20 the approved command ran")
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H20OWNER/, "H20 owner turn stored answer")
    const afterOwner = stream.frames.length
    await api.promptAsync(workspace.directory, session.id, "Reply with exactly this one token: H20QUEUED")
    await stream.waitFor((frame) => stream.frames.indexOf(frame) >= afterOwner && frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H20 queued Pi turn" })
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H20QUEUED/, "H20 queued turn stored answer")
    assert.equal((await api.session(workspace.directory, session.id)).id, session.id, "H20 session readback")
    assert.deepEqual([...new Set(stack.scripted.requests.filter((request) => /H20(OWNER|QUEUED)/.test(request.prompt)).map((request) => request.authorization))],
      ["Bearer test-key"], "H20 every turn spent the session owner's stored account")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
  } finally { await stack.close() }
}
