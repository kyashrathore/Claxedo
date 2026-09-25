import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type QuestionRow } from "../harness/api"
import { unexpectedEgress } from "../harness/egress-guard"
import { startStack } from "../harness/stack"
import { frameSessionId, frameType, type EventStream } from "../harness/stream"

const NATIVE = [
  { id: "claude", providerId: "anthropic", modelId: "claude-sonnet-4-5", tool: "AskUserQuestion" },
  { id: "codex", providerId: "openai", modelId: "gpt-4.1", tool: "request_user_input" },
] as const

async function pending(api: ClaxedoApi, stream: EventStream, directory: string, sessionId: string): Promise<QuestionRow> {
  await stream.waitFor((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === sessionId,
    { label: `native question for ${sessionId}`, timeoutMs: 60_000 })
  const row = (await api.questions(directory)).find((item) => item.sessionID === sessionId)
  assert.ok(row, `${sessionId} did not retain a native question after question.asked`)
  return row
}

export async function run() {
  const stack = await startStack({ label: "h4-native-questions" })
  try {
    const { directory } = await stack.daemon.makeWorkspace("h4-native-questions")
    const api = new ClaxedoApi(stack.url)
    const stream = await stack.events(directory)
    for (const harness of NATIVE) {
      const marker = `H4_${harness.id.toUpperCase()}_QUESTION`
      stack.scripted.scriptTool({ name: harness.tool, whenPromptIncludes: marker,
        input: { questions: [
          { id: "environment", header: "Environment", question: "Which environment?", options: [
            { label: "Staging", description: "Use the isolated workspace" },
            { label: "Production", description: "Use production" },
          ], ...(harness.id === "claude" ? { multiSelect: false } : {}) },
          { id: "reason", header: "Reason", question: "Why this environment?", options: [
            { label: "Safety", description: "Avoid production changes" },
            { label: "Speed", description: "Run the test quickly" },
          ],
            ...(harness.id === "claude" ? { multiSelect: false } : {}) },
        ] },
      })
      const session = await api.createSession(directory, { harness: { id: harness.id, access: "native" },
        model: { providerId: harness.providerId, modelId: harness.modelId } })
      await api.promptAsync(directory, session.id, `Ask the questions, then reply with exactly this one token: ${marker}`)
      const row = await pending(api, stream, directory, session.id)
      assert.ok(stream.frames.some((frame) => frameType(frame) === "question.asked" && frameSessionId(frame) === session.id))
      await api.replyQuestion(directory, row.id, [["Staging"], ["Keep the test isolated"]])
      await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === session.id,
        { label: `${harness.id} question turn idle`, timeoutMs: 60_000 })
      assert.equal((await api.questions(directory)).some((question) => question.id === row.id), false)
      const messages = await api.messages(directory, session.id)
      assert.match(assistantText(messages), new RegExp(marker))
      assert.ok(stack.scripted.requests.some((request) => request.prompt.includes("Keep the test isolated")),
        `${harness.id} did not send the free-text answer back to the model`)
      assert.equal((await api.session(directory, session.id)).id, session.id)
      console.log(`H4 ${harness.id}: structured choice and free text question reached live and stored readbacks`)
    }
    assert.ok(stack.scripted.counts().messages > 0)
    assert.ok(stack.scripted.counts().responses > 0)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [])
    console.log(`H4 native background attempts refused by guard: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
