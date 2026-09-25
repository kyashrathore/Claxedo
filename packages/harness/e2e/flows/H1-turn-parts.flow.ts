import assert from "node:assert/strict"
import { ClaxedoApi, assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { connectNativeScriptedProviders } from "../harness/native-scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { assertStoredPartsMatchLive, waitForIdle } from "../harness/turn-observations"

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
  await api.prompt(directory, session.id, `Reply with exactly this one token: ${marker}`, model ? { model } : {})
  await waitForIdle(stream, session.id)
  const messages = await api.messages(directory, session.id)
  assert.match(assistantText(messages), new RegExp(marker))
  assertStoredPartsMatchLive(messages, stream, session.id)
  assert.ok(stack.scripted.requests.some((request) => request.prompt.includes(marker)), `${harness} did not reach the scripted model`)
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log(`H1 ${harness}: scripted model, live text, stored text, finish, and session readback passed`)
}

export async function run() {
  const stack = await startStack({ label: "h1-turn-parts" })
  try {
    await connectNativeScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    await acpParts(stack, api)
    for (const harness of ["pi", "claude", "codex"] as const) await modelParts(stack, api, harness)
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
    console.log(`H1 guard refused background attempts: ${JSON.stringify(stack.egress.attempts)}`)
  } finally {
    await stack.close()
  }
}
