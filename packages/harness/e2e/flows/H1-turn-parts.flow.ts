import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { eventually } from "../harness/eventually"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { assertStoredPartsMatchLive, assertTurnFinished, waitForIdle } from "../harness/turn-observations"

async function acpParts(stack: Stack, api: ClaxedoApi) {
  const directory = (await stack.daemon.makeWorkspace("h1-acp")).directory
  await stack.acp.write("h1-parts", { steps: [
    { kind: "reasoning", text: "Inspect the file first" },
    { kind: "text", text: "H1_ACP_TEXT", chunks: 2 },
    { kind: "tool", tool: "read", title: "Read sample", input: { path: "sample.txt" }, output: "sample contents" },
    { kind: "tool", tool: "execute", title: "Fail example", input: { command: "false" }, text: "example failed", status: "failed" },
    { kind: "diff", path: "sample.txt", oldText: "before", newText: "after" },
    { kind: "plan", entries: [{ content: "H1 inspect and change sample.txt", priority: "high", status: "completed" }] },
  ] })
  const stream = await stack.events(directory)
  const session = await api.createSession(directory, { harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(directory, session.id, `Exercise all ACP parts. ${acpScriptToken("h1-parts")}`)
  await waitForIdle(stream, session.id)
  const messages = await api.messages(directory, session.id)
  const { live, stored } = assertStoredPartsMatchLive(messages, stream, session.id)
  assertTurnFinished(messages, stream, session.id)
  assert.match(assistantText(messages), /H1_ACP_TEXT/)
  assert.ok(stored.some((part) => part.type === "reasoning"), "ACP reasoning was not stored")
  assert.ok(stored.some((part) => part.type === "tool" && (part.state as { status?: string })?.status === "error"), "ACP failed tool was not stored")
  assert.ok(stored.some((part) => part.type === "tool" && (part.state as { input?: { path?: string } })?.input?.path === "sample.txt"), "ACP tool input was not stored")
  assert.ok(stored.some((part) => part.type === "tool" && JSON.stringify(part.state).includes("sample contents")), "ACP tool output was not stored")
  assert.ok([...live.values()].some((part) => part.type === "tool" && JSON.stringify(part).includes("after")), "ACP file change was not streamed")
  assert.ok(stream.frames.some((frame) => JSON.stringify(frame).includes("H1 inspect and change sample.txt")), "ACP todo was not streamed")
  assert.ok((await api.todos(directory, session.id)).some((todo) => todo.content === "H1 inspect and change sample.txt"), "ACP todo was not stored")
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log("H1 ACP: text, reasoning, tool input/output/failure, diff, todo, finish, and session readback passed")
}

async function modelParts(stack: Stack, api: ClaxedoApi, harness: "pi" | "claude" | "codex") {
  const directory = (await stack.daemon.makeWorkspace(`h1-${harness}`)).directory
  const stream = await stack.events(directory)
  const model = harness === "pi" ? { providerId: "pi", modelId: "openai/gpt-4.1" } : undefined
  const session = await api.createSession(directory, { harness: { id: harness, access: "native" }, ...(model ? { model } : {}) })
  const marker = `H1_${harness.toUpperCase()}_TEXT`
  const file = path.join(directory, "h1-created.txt")
  if (harness === "pi") stack.scripted.scriptToolSequence(marker, [
    { name: "write", input: { path: file, content: "H1 Pi file change" } },
    { name: "bash", input: { command: "false" } },
  ])
  if (harness === "claude") stack.scripted.scriptToolSequence(marker, [
    { name: "Write", input: { file_path: file, content: "H1 Claude file change" } },
    { name: "TaskCreate", input: { subject: "H1 Claude todo", description: "Exercise the task projection", activeForm: "Saving task" } },
    { name: "Bash", input: { command: "false", description: "Exercise tool failure" } },
  ])
  if (harness === "claude" || harness === "codex") stack.scripted.scriptText({
    marker,
    text: marker,
    reasoning: `H1 ${harness} reasoning`,
  })
  if (harness === "codex") stack.scripted.scriptToolSequence(marker, [
    { name: "exec_command", input: { cmd: "printf 'H1 Codex file change' > h1-created.txt; printf 'H1 Codex wrote file'", workdir: directory } },
    { name: "exec_command", input: { cmd: "false", workdir: directory } },
    { name: "update_plan", input: { plan: [{ step: "H1 Codex todo", status: "completed" }] } },
  ])
  await api.prompt(directory, session.id, `Reply with exactly this one token: ${marker}`, model ? { model } : {})
  await waitForIdle(stream, session.id)
  const messages = await eventually(`${harness} completed native tools`, async () => {
    const current = await api.messages(directory, session.id)
    return current.flatMap((message) => message.parts).filter((part) => part.type === "tool").length >= (harness === "claude" ? 3 : 2)
      ? current : undefined
  })
  assert.match(assistantText(messages), new RegExp(marker))
  assertStoredPartsMatchLive(messages, stream, session.id)
  assertTurnFinished(messages, stream, session.id)
  const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
  if (harness !== "pi") {
    const reasoning = messages.flatMap((message) => message.parts).filter((part) => part.type === "reasoning")
    assert.ok(reasoning.some((part) => String(part.text).includes(`H1 ${harness} reasoning`)), `${harness} reasoning was not stored`)
  }
  const expected = harness === "pi" ? "H1 Pi file change" : harness === "claude" ? "H1 Claude file change" : "H1 Codex file change"
  assert.equal(await fs.readFile(file, "utf8"), expected, `${harness} file change was not applied`)
  assert.ok(tools.some((part) => (part.state as { status?: string; input?: Record<string, unknown>; output?: unknown })?.status === "completed"
    && JSON.stringify((part.state as { input?: unknown }).input).includes(harness === "codex" ? "h1-created.txt" : file)
    && Boolean((part.state as { output?: unknown }).output)), `${harness} completed file tool input/output was not stored`)
  assert.ok(tools.some((part) => (part.state as { status?: string; error?: unknown })?.status === "error"
    && Boolean((part.state as { error?: unknown }).error)), `${harness} failed tool was not stored`)
  if (harness !== "pi") {
    const expectedTodo = harness === "claude" ? "H1 Claude todo" : "H1 Codex todo"
    assert.ok((await api.todos(directory, session.id)).some((todo) => todo.content.includes(expectedTodo)), `${harness} todo was not stored`)
    assert.ok(stream.frames.some((frame) => JSON.stringify(frame).includes(expectedTodo)), `${harness} todo was not streamed`)
  }
  assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(marker)), `${harness} did not reach the scripted model`)
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log(`H1 ${harness}: scripted model, live text, stored text, finish, and session readback passed`)
}

export async function run() {
  const stack = await startStack({ label: "h1-turn-parts" })
  try {
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    await acpParts(stack, api)
    for (const harness of ["pi", "claude", "codex"] as const) await modelParts(stack, api, harness)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
    console.log(`H1 guard refused background attempts: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
