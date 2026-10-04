import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { ownerPiAgentDir } from "../harness/pi-owner"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { waitForTitle } from "../harness/turn-observations"

export async function run() {
  const stack = await startStack({ label: "h18-pi-owner" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h18")
    const own = ownerPiAgentDir(stack)
    const auth = Buffer.from('{"h18":"owner-login-sentinel"}\n')
    await fs.mkdir(own, { recursive: true })
    await fs.writeFile(path.join(own, "auth.json"), auth)
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(workspace.directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model })
    stack.scripted.scriptTool({ name: "write", input: { path: "h18.txt", content: "written by embedded pi\n" }, whenPromptIncludes: "H18WRITE" })
    await api.prompt(workspace.directory, session.id, "Write the file, then reply with exactly this one token: H18WRITE", { model, title: true })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id, { label: "H18 tool turn idle" })
    await waitForTitle(stream, session.id)
    assert.equal(await fs.readFile(path.join(workspace.directory, "h18.txt"), "utf8"), "written by embedded pi\n", "H18 Pi's own write tool wrote the workspace file")
    assert.match(assistantText(await api.messages(workspace.directory, session.id)), /H18WRITE/, "H18 stored answer")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "message.part.updated" && frameSessionId(frame) === session.id
      && JSON.stringify(frame.data.payload).includes('"type":"tool"')), "H18 live tool card")
    assert.equal((await api.session(workspace.directory, session.id)).lastTurn?.status, "completed")
    const modelRequests = stack.scripted.requests.filter((request) => request.prompt.includes("H18WRITE"))
    assert.ok(modelRequests.length >= 2, "H18 the tool result went back to the model")
    assert.deepEqual([...new Set(modelRequests.map((request) => request.authorization))], ["Bearer test-key"], "H18 Pi spent only the owner's stored account")
    assert.ok((await fs.readFile(path.join(own, "auth.json"))).equals(auth), "H-6: the owner's own Pi login changed")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
  } finally { await stack.close() }
}
