import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { writePiDialogExtension } from "../harness/pi-dialog-extension"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h4-pi-timeout" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h4-pi-timeout")
    const { directory } = workspace
    const agentDir = path.join(stack.dataDir, "agent-core", workspace.id, "pi", "agent")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }))
    await writePiDialogExtension(directory)
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    const model = { providerId: "pi", modelId: "openai/gpt-4.1" }
    const session = await api.createSession(directory, { harness: { id: "pi", access: "native" }, model })
    await api.promptAsync(directory, session.id, "Reply with exactly this one token: PI_TIMEOUT")
    for (const [title, answer] of [
      ["Select environment", "Staging"], ["Confirm environment", "Yes"],
      ["Explain environment", "Keep the test isolated"], ["Edit summary", "Edited summary"],
    ]) {
      const deadline = Date.now() + 30_000
      let question = (await api.questions(directory)).find((row) => row.sessionID === session.id
        && (row.questions as Array<{ question?: string }>)[0]?.question === title)
      while (!question && Date.now() < deadline) {
        await Bun.sleep(50)
        question = (await api.questions(directory)).find((row) => row.sessionID === session.id
          && (row.questions as Array<{ question?: string }>)[0]?.question === title)
      }
      assert.ok(question, `${title} never surfaced as a Pi dialog`)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id))
      await api.replyQuestion(directory, question.id, [[answer]])
    }
    await stream.waitFor((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id
      && stream.frames.filter((item) => frameType(item) === "question.asked" && frameSessionId(item) === session.id).length >= 5,
    { label: "Pi extension timeout question" })
    await Bun.sleep(600)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "question.expired" && frameSessionId(frame) === session.id),
      "Pi timed-out dialog produced no expired request event")
    assert.equal((await api.questions(directory)).some((row) => row.sessionID === session.id), false,
      "Pi timed-out extension dialog remained pending")
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "pi-dialog-receipt.json"), "utf8")), {
      selected: "Staging", confirmed: true, input: "Keep the test isolated", edited: "Edited summary", timeout: "undefined",
    })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
      { label: "Pi timeout turn idle" })
    assert.match(assistantText(await api.messages(directory, session.id)), /PI_TIMEOUT/)
    assert.equal((await api.session(directory, session.id)).id, session.id)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H4 Pi: select, confirm, input, editor and timed-out input reached the extension and left no pending question")
  } finally {
    await stack.close()
  }
}
