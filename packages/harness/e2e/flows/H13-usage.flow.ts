import assert from "node:assert/strict"
import { ClaxedoApi, assistantText, type SessionHarness } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { eventually } from "../harness/eventually"
import { connectNativeScriptedProviders } from "../harness/native-scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport } from "../harness/transport"
import { waitForIdle } from "../harness/turn-observations"

async function usageTurn(stack: Stack, api: ClaxedoApi, name: "acp" | "pi" | "claude" | "codex") {
  const directory = (await stack.daemon.makeWorkspace(`h13-${name}`)).directory
  const stream = await stack.events(directory)
  const harness: SessionHarness = name === "acp" ? SCRIPTED_ACP_HARNESS : { id: name, access: "native" }
  const model = name === "pi" ? { providerId: "pi", modelId: "openai/gpt-4.1" } : undefined
  const session = await api.createSession(directory, { harness, ...(model ? { model } : {}) })
  const marker = `H13_${name.toUpperCase()}_USAGE`
  if (name === "acp") await stack.acp.write("h13-usage", {
    steps: [{ kind: "text", text: marker }],
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16, thoughtTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0 },
  })
  const prompt = name === "acp" ? `Report usage. ${acpScriptToken("h13-usage")}` : `Reply with exactly this one token: ${marker}`
  await api.prompt(directory, session.id, prompt, model ? { model } : {})
  await waitForIdle(stream, session.id)
  const assistant = await eventually(`${name} assistant model usage`, async () => {
    const messages = await api.messages(directory, session.id)
    assert.match(assistantText(messages), new RegExp(marker))
    const last = messages.filter((message) => message.info.role === "assistant").at(-1)
    const tokens = last?.info.tokens as { input?: number; output?: number } | undefined
    return tokens?.input && tokens.output ? last : undefined
  }, 10_000)
  const tokens = assistant.info.tokens as { input: number; output: number }
  assert.ok(stream.frames.some((frame) => frameType(frame) === "message.updated" && frameSessionId(frame) === session.id
    && JSON.stringify(frame.data.payload).includes('"tokens"')), `${name} usage was not streamed`)
  const totals = await eventually(`${name} usage totals`, async () => {
    const result = await api.usageForSession(session.id)
    return result.claxedo.totals.turnCount > 0 && result.claxedo.totals.input > 0 ? result.claxedo.totals : undefined
  }, 20_000)
  assert.ok(totals.input >= tokens.input, `${name} session input total is smaller than message usage`)
  assert.ok(totals.output >= tokens.output, `${name} session output total is smaller than message usage`)
  assert.equal((await api.session(directory, session.id)).id, session.id)
  console.log(`H13 ${name}: assistant usage ${tokens.input}/${tokens.output}; session totals ${totals.input}/${totals.output}; live frame and session readback passed`)
}

export async function run() {
  const stack = await startStack({ label: "h13-usage" })
  try {
    await connectNativeScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    const failures: Error[] = []
    for (const name of ["acp", "pi", "claude", "codex"] as const) {
      try {
        await usageTurn(stack, api, name)
      } catch (error) {
        failures.push(new Error(`H13 ${name}: ${String(error)}`, { cause: error }))
      }
    }
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
    if (failures.length) throw new AggregateError(failures, "H13 usage variants failed")
  } finally {
    await stack.close()
  }
}
