import assert from "node:assert/strict"
import { ApiError, ClaxedoApi, assistantText, type MessageRow, type SessionHarness } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { connectNativeScriptedProviders } from "../harness/native-scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport } from "../harness/transport"
import { assertStoredPartsMatchLive, waitForIdle } from "../harness/turn-observations"

type History = { name: string; directory: string; sessionId: string; messages: MessageRow[]; todos?: Awaited<ReturnType<ClaxedoApi["todos"]>> }

async function createHistory(stack: Stack, api: ClaxedoApi, name: "acp" | "pi" | "claude" | "codex"): Promise<History> {
  const directory = (await stack.daemon.makeWorkspace(`h27-${name}`)).directory
  const stream = await stack.events(directory)
  const harness: SessionHarness = name === "acp" ? SCRIPTED_ACP_HARNESS : { id: name, access: "native" }
  const model = name === "pi" ? { providerId: "pi", modelId: "openai/gpt-4.1" } : undefined
  const marker = `H27_${name.toUpperCase()}_HISTORY`
  if (name === "acp") await stack.acp.write("h27-history", { steps: [
    { kind: "text", text: marker },
    { kind: "tool", tool: "read", title: "Read history", input: { path: "history.txt" }, output: "history contents" },
    { kind: "plan", entries: [{ content: "H27 persistent ACP todo", priority: "high", status: "completed" }] },
  ] })
  if (name === "claude") stack.scripted.scriptTool({
    name: "TaskCreate",
    input: { subject: "H27 persistent task", description: "Keep after daemon restart", activeForm: "Saving task" },
    whenPromptIncludes: marker,
  })
  const session = await api.createSession(directory, { harness, ...(model ? { model } : {}) })
  const prompt = name === "acp" ? `Show history. ${acpScriptToken("h27-history")}` : `Reply with exactly this one token: ${marker}`
  await api.prompt(directory, session.id, prompt, model ? { model } : {})
  await waitForIdle(stream, session.id)
  const messages = await api.messages(directory, session.id)
  assert.match(assistantText(messages), new RegExp(marker))
  assertStoredPartsMatchLive(messages, stream, session.id)
  const todos = name === "claude" || name === "acp" ? await api.todos(directory, session.id) : undefined
  if (todos) {
    const expected = name === "claude" ? "H27 persistent task" : "H27 persistent ACP todo"
    assert.ok(todos.some((todo) => todo.content.includes(expected)), `${name} todo was not stored: ${JSON.stringify(todos)}`)
    assert.ok(stream.frames.some((frame) => frameType(frame) === "todo.updated" && frameSessionId(frame) === session.id), `${name} todo was not streamed`)
  }
  assert.equal((await api.session(directory, session.id)).id, session.id)
  stream.close()
  console.log(`H27 ${name}: live and stored history${todos ? " and todos" : ""} prepared`)
  return { name, directory, sessionId: session.id, messages, ...(todos ? { todos } : {}) }
}

export async function run() {
  const stack = await startStack({ label: "h27-history-restart" })
  try {
    await connectNativeScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    const histories: History[] = []
    for (const name of ["acp", "pi", "claude", "codex"] as const) histories.push(await createHistory(stack, api, name))
    await stack.daemon.restart()
    assert.equal(stack.daemon.dataDir, stack.dataDir)
    for (const history of histories) {
      let recovered: MessageRow[]
      try {
        recovered = await api.messages(history.directory, history.sessionId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) assert.fail(`${history.name} history missing after restart`)
        throw error
      }
      assert.deepEqual(recovered, history.messages, `${history.name} history changed after restart`)
      if (history.todos) assert.deepEqual(await api.todos(history.directory, history.sessionId), history.todos, `${history.name} todos changed after restart`)
      assert.equal((await api.session(history.directory, history.sessionId)).id, history.sessionId)
      console.log(`H27 ${history.name}: messages, parts, and session read back after daemon restart`)
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
  } finally {
    await stack.close()
  }
}
