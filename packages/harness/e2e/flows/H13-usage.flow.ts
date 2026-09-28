import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { ClaxedoApi, assistantText, type SessionHarness } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { acpScriptToken } from "../harness/acp/script"
import { unexpectedEgress } from "../harness/egress-guard"
import { eventually } from "../harness/eventually"
import { runtimeSources } from "../harness/journal-observations"
import { connectScriptedProviders } from "../harness/scripted-providers"
import { startStack, type Stack } from "../harness/stack"
import { frameSessionId, frameType } from "../harness/stream"
import { directTransport } from "../harness/transport"
import { waitForIdle } from "../harness/turn-observations"

export async function usageTurn(stack: Stack, api: ClaxedoApi, name: "acp" | "pi" | "claude" | "codex") {
  const directory = (await stack.daemon.makeWorkspace(`h13-${name}`)).directory
  const stream = await stack.events(directory)
  const harness: SessionHarness = name === "acp" ? SCRIPTED_ACP_HARNESS : { id: name, access: "native" }
  const model = name === "pi" ? { providerId: "pi", modelId: "groq/qwen/qwen3.6-27b" } : undefined
  const session = await api.createSession(directory, { harness, ...(model ? { model } : {}) })
  const marker = `H13_${name.toUpperCase()}_USAGE`
  if (name === "acp") await stack.acp.write("h13-usage", {
    steps: [{ kind: "text", text: marker }],
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16, thoughtTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0 },
  })
  const prompt = name === "acp" ? `Report usage. ${acpScriptToken("h13-usage")}` : `Reply with exactly this one token: ${marker}`
  await api.prompt(directory, session.id, prompt, model ? { model } : {})
  await waitForIdle(stream, session.id)
  const sources = await runtimeSources(stack.dataDir, session.id)
  if (name !== "acp") {
    const dialect = name === "claude" ? "messages" : name === "codex" ? "responses" : "chat"
    assert.ok(stack.scripted.requests.some((request) => request.dialect === dialect && request.prompt.includes(marker)),
      `${name} did not reach the scripted ${dialect} endpoint`)
    const method = name === "claude" ? "claude.result" : name === "codex" ? "thread/tokenUsage/updated" : "message_end"
    assert.ok(sources.some((entry) => entry.type === "session.usage" && entry.source.method === method),
      `${name} CLI did not report usage through ${method}`)
  }
  assert.ok(sources.some((entry) => entry.type === "session.usage"), `${name} runtime did not project session usage`)
  console.log(`H13 ${name} projected usage events: ${JSON.stringify(sources.filter((entry) => entry.type === "session.usage").map((entry) => entry.payload))}`)
  if (name === "codex") console.log(`H13 Codex rate-limit reports: ${JSON.stringify(sources.filter((entry) => entry.source.method === "account/rateLimits/updated").map((entry) => entry.payload))}`)
  const firstTotals = await api.usageForSession(session.id)
  assert.ok(firstTotals.claxedo.totals.input > 0 && firstTotals.claxedo.totals.output > 0,
    `${name} session totals did not receive usage`)
  console.log(`H13 ${name} first totals/quota keys: ${JSON.stringify({ totals: firstTotals.claxedo.totals, quota: firstTotals.quota && typeof firstTotals.quota === "object" ? Object.keys(firstTotals.quota) : [] })}`)
  const assistant = await eventually(`${name} assistant model usage`, async () => {
    const messages = await api.messages(directory, session.id)
    assert.match(assistantText(messages), new RegExp(marker))
    const last = messages.filter((message) => message.info.role === "assistant").at(-1)
    const tokens = last?.info.tokens as { input?: number; output?: number } | undefined
    return tokens?.input && tokens.output ? last : undefined
  }, 10_000)
  const tokens = assistant.info.tokens as { input: number; output: number }
  assert.ok(stream.frames.some((frame) => {
    const info = (frame.data.payload as { properties?: { info?: { id?: unknown; tokens?: unknown } } } | undefined)?.properties?.info
    return frameType(frame) === "message.updated" && frameSessionId(frame) === session.id && info?.id === assistant.info.id
      && isDeepStrictEqual(info.tokens, assistant.info.tokens)
  }), `${name} usage was not streamed`)
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
    await connectScriptedProviders(directTransport, stack.url, stack.scripted)
    const api = new ClaxedoApi(stack.url)
    await usageTurn(stack, api, "acp")
    assert.deepEqual(unexpectedEgress(stack.egress.attempts), [], "unexpected outbound egress attempted")
  } finally {
    await stack.close()
  }
}
