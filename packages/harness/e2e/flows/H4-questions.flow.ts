import assert from "node:assert/strict"
import { ApiError, ClaxedoApi, assistantText, type QuestionRow } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readElicitationReceipts } from "../harness/acp/receipts"
import { installStartupAcp, STARTUP_ACP_HARNESS } from "../harness/acp/startup-connection"
import { acpScriptToken, type AcpScript } from "../harness/acp/script"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

async function pending(api: ClaxedoApi, directory: string, sessionId: string): Promise<QuestionRow> {
  const deadline = Date.now() + 30_000
  do {
    const row = (await api.questions(directory)).find((item) => item.sessionID === sessionId)
    if (row) return row
    await Bun.sleep(50)
  } while (Date.now() < deadline)
  throw new Error(`Question for ${sessionId} never became pending`)
}

async function questionTurn(input: {
  stack: Stack; api: ClaxedoApi; stream: EventStream; directory: string; name: string; script: AcpScript
  answer: (row: QuestionRow) => string[][]; expected: string; action: "accept" | "decline"; message: string
}) {
  const { stack, api, stream, directory, name, script } = input
  const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: `H4 ${name}` })
  await stack.acp.write(name, script)
  await api.promptAsync(directory, session.id, acpScriptToken(name))
  const row = await pending(api, directory, session.id)
  assert.ok(stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id))
  await api.replyQuestion(directory, row.id, input.answer(row))
  await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
    { label: `${name} idle` })
  assert.equal((await api.questions(directory)).some((item) => item.id === row.id), false)
  assert.match(assistantText(await api.messages(directory, session.id)), new RegExp(input.expected))
  assert.equal((await api.session(directory, session.id)).id, session.id)
  const receipts = await readElicitationReceipts(stack.acp.scriptDir)
  assert.equal(receipts.find((receipt) => receipt.message === input.message)?.action, input.action)
  assert.ok(stream.frames.some((frame) => frameType(frame) === "question.replied" && frameSessionId(frame) === session.id))
}

export async function run() {
  const stack = await startStack({ label: "h4-questions" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h4-questions")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    await questionTurn({ stack, api, stream, directory, name: "free-text", message: "Describe your change",
      script: { steps: [{ kind: "question", message: "Describe your change" }] },
      answer: () => [[JSON.stringify({ answer: "Use the narrow fix" })]], expected: "Use the narrow fix", action: "accept" })
    await questionTurn({ stack, api, stream, directory, name: "form", message: "Choose deployment",
      script: { steps: [{ kind: "question", message: "Choose deployment", schema: {
        type: "object", properties: { answer: { type: "string", enum: ["local", "cloud"] } }, required: ["answer"],
      } }] },
      answer: () => [[JSON.stringify({ answer: "local" })]], expected: "local", action: "accept" })
    await questionTurn({ stack, api, stream, directory, name: "url", message: "Connect account",
      script: { steps: [{ kind: "question", mode: "url", message: "Connect account", url: "https://example.test/consent" }] },
      answer: (row) => {
        const option = (row.questions as Array<{ options: Array<{ label: string }> }>)[0]?.options[0]
        assert.ok(option)
        return [[option.label]]
      },
      expected: "accept", action: "accept" })
    await installStartupAcp(stack.url, stack.acp.scriptDir)
    const creating = api.createSession(directory, { harness: STARTUP_ACP_HARNESS, title: "H4 startup" })
    const startupDeadline = Date.now() + 30_000
    let startup = (await api.questions(directory)).find((row) =>
      (row.questions as Array<{ question?: string }>)[0]?.question?.includes("Choose before session creation"))
    while (!startup && Date.now() < startupDeadline) {
      await Bun.sleep(50)
      startup = (await api.questions(directory)).find((row) =>
        (row.questions as Array<{ question?: string }>)[0]?.question?.includes("Choose before session creation"))
    }
    assert.ok(startup, "startup elicitation was absent while session/new was pending")
    assert.ok(stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === startup.sessionID),
      "startup elicitation was absent from live frames")
    assert.equal((await api.sessionStart(directory, startup.sessionID)).status, "starting")
    await api.replyQuestion(directory, startup.id, [[JSON.stringify({ answer: "ready" })]])
    const created = await creating
    assert.equal(created.id, startup.sessionID)
    assert.equal((await api.sessionStart(directory, created.id)).status, "created")
    assert.equal((await readElicitationReceipts(stack.acp.scriptDir)).find((row) => row.message === "Choose before session creation")?.action, "accept")
    await api.prompt(directory, created.id, "Continue")
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === created.id,
      { label: "startup session idle" })
    assert.match(assistantText(await api.messages(directory, created.id)), /Startup answer accepted/)
    const validation = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS, title: "H4 validation cancellation" })
    await stack.acp.write("validation-cancel", { steps: [{ kind: "question", message: "Validate the response", schema: {
      type: "object", properties: { answer: { type: "string", pattern: "^(a+)+$" } }, required: ["answer"],
    } }] })
    await api.promptAsync(directory, validation.id, acpScriptToken("validation-cancel"))
    const validationQuestion = await pending(api, directory, validation.id)
    const validating = api.replyQuestion(directory, validationQuestion.id,
      [[JSON.stringify({ answer: `${"a".repeat(32_000)}!` })]]).then(() => null, (error: unknown) => error)
    await Bun.sleep(30)
    await api.rejectQuestion(directory, validationQuestion.id)
    const refusal = await validating
    assert.ok(refusal instanceof ApiError && refusal.status === 409, `validation reply was not cancelled: ${String(refusal)}`)
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === validation.id,
      { label: "cancelled validation idle" })
    assert.equal((await api.questions(directory)).some((row) => row.id === validationQuestion.id), false)
    assert.match(assistantText(await api.messages(directory, validation.id)), /decline/)
    assert.equal((await readElicitationReceipts(stack.acp.scriptDir)).find((row) => row.message === "Validate the response")?.action, "decline")
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H4 ACP: free text, form, URL consent, startup elicitation, and validation cancellation passed live, stored, and server readbacks")
  } finally {
    await stack.close()
  }
}
