import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { writePiDialogExtension } from "../harness/pi-dialog-extension"
import { forgetStoredAccounts, ownerPiAgentDir, writeOwnerPiModels } from "../harness/pi-owner"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"

export async function run() {
  const stack = await startStack({ label: "h4-pi-dialogs" })
  try {
    const workspace = await stack.daemon.makeWorkspace("h4-pi-dialogs")
    const { directory } = workspace
    const agentDir = ownerPiAgentDir(stack)
    await writeOwnerPiModels(agentDir, stack.scripted.v1Url, "h4-scripted")
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }))
    await forgetStoredAccounts(stack)
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
      await stream.waitFor((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id
        && (frame.data.payload as { properties?: { questions?: Array<{ question?: string }> } }).properties?.questions?.[0]?.question === title,
      { label: `Pi ${title} question` })
      const question = (await api.questions(directory)).find((row) => row.sessionID === session.id
        && (row.questions as Array<{ question?: string }>)[0]?.question === title)
      assert.ok(question, `${title} never surfaced as a Pi dialog`)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id))
      await api.replyQuestion(directory, question.id, [[answer]])
    }
    await stream.waitFor((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id
      && stream.frames.filter((item) => frameType(item) === "question.asked" && frameSessionId(item) === session.id).length >= 5,
    { label: "Pi extension timeout question" })
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
      { label: "Pi timeout turn idle" })
    await stream.waitFor((frame) => frameType(frame) === "session.updated" && frameSessionId(frame) === session.id
      && (frame.data.payload as { properties?: { info?: { titleSource?: string } } }).properties?.info?.titleSource === "harness",
    { label: "Pi dialog turn title" })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "pi-dialog-receipt.json"), "utf8")), {
      selected: "Staging", confirmed: true, input: "Keep the test isolated", edited: "Edited summary", timeout: "undefined",
    })
    assert.equal((await api.questions(directory)).some((row) => row.sessionID === session.id), false,
      "Pi timed-out extension dialog remained pending")
    assert.match(assistantText(await api.messages(directory, session.id)), /PI_TIMEOUT/)
    assert.equal((await api.session(directory, session.id)).id, session.id)
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H4 Pi: select, confirm, input and editor reached the extension; live frames, stored answer and session readback passed")
  } finally {
    await stack.close()
  }
}
