import assert from "node:assert/strict"
import { ApiError, ClaxedoApi } from "../harness/api"
import { startStack, type Stack } from "../harness/stack"
import type { ScriptedModelRequest } from "../harness/scripted-model-server"
import { frameSessionId, frameType } from "../harness/stream"

type Harness = "claude" | "codex"

async function opening(stack: Stack, marker: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([stack.scripted.textGateReached(marker), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Model request never reached ${marker}\n${stack.daemon.log()}`)), 30_000)
    })])
  } finally { clearTimeout(timeout) }
}

function effort(request: ScriptedModelRequest | undefined, harness: Harness) {
  const body = request?.body as { output_config?: { effort?: string }; reasoning?: { effort?: string } }
  return harness === "claude" ? body.output_config?.effort : body.reasoning?.effort
}

async function changeDuringTool(stack: Stack, api: ClaxedoApi, directory: string, sessionId: string, harness: Harness,
  marker: string, change: () => Promise<void>) {
  const stream = await stack.events(directory)
  const release = stack.scripted.holdOpeningReplies(marker)
  try {
    stack.scripted.scriptTool({ name: harness === "claude" ? "Bash" : "exec_command", whenPromptIncludes: marker,
      input: harness === "claude" ? { command: "printf model-boundary" } : { cmd: "printf model-boundary" } })
    await api.promptAsync(directory, sessionId, `Run the scripted tool ${marker}`)
    await opening(stack, marker)
    await change()
    release()
    await stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId,
      { label: `${harness} live model turn idle`, timeoutMs: 60_000 })
    const requests = stack.scripted.requests.filter((request) => request.prompt.includes(marker))
    assert.ok(requests.length >= 2, "The original turn must make another model request")
    return requests
  } catch (cause) { throw new Error(`${String(cause)}\n${stack.daemon.log()}`, { cause }) }
  finally { release(); stream.close() }
}

async function refusedSettings(api: ClaxedoApi, directory: string, sessionId: string, harness: Harness) {
  const before = await api.sessionConfig(directory, sessionId)
  await assert.rejects(api.updateSessionConfig(directory, sessionId, { variant: "unsupported-effort" }),
    (error) => error instanceof ApiError && error.status === 409 && error.body.includes("session_config_refused"))
  if (harness === "codex") {
    await assert.rejects(api.updateSessionConfig(directory, sessionId, { model: { providerID: "codex", modelID: "claxedo-nonexistent-model" } }),
      (error) => error instanceof ApiError && error.status === 409 && error.body.includes("destination model has only fallback metadata"))
  }
  assert.deepEqual(await api.sessionConfig(directory, sessionId), before, "Refusals must retain the saved selection")
}

async function resetEffort(stack: Stack, api: ClaxedoApi, directory: string, harness: Harness, model: string, defaultEffort?: string) {
  const provider = harness === "claude" ? "anthropic" : "codex"
  const session = await api.createSession(directory, { harness: { id: harness, access: "native" },
    model: { providerId: provider, modelId: model }, title: "Reset live effort" })
  const override = harness === "claude" ? "low" : "high"
  assert.notEqual(override, defaultEffort)
  await api.updateSessionConfig(directory, session.id, { variant: override })
  const requests = await changeDuringTool(stack, api, directory, session.id, harness, `LIVEDEFAULT${harness.toUpperCase()}`, async () => {
    await api.updateSessionConfig(directory, session.id, { variant: null })
    assert.equal((await api.sessionConfig(directory, session.id)).variant, null)
  })
  assert.equal(effort(requests[0], harness), override)
  assert.notEqual(effort(requests.at(-1), harness), override)
  if (harness === "codex") assert.equal(effort(requests.at(-1), harness), defaultEffort)
  assert.equal(requests[0]?.model, requests.at(-1)?.model)
}

async function liveModelSettings(harness: Harness) {
  const stack = await startStack({ label: `h10-live-model-${harness}` })
  try {
    const api = new ClaxedoApi(stack.url)
    const { directory } = await stack.daemon.makeWorkspace(`live-model-${harness}`)
    const provider = harness === "claude" ? "anthropic" : "codex"
    const session = await api.createSession(directory, { harness: { id: harness, access: "native" },
      model: { providerId: provider, modelId: harness === "claude" ? "default" : "gpt-5.5" }, title: "Live model settings" })
    const model = harness === "claude" ? "sonnet" : "gpt-5.6-sol"
    const options = (await api.configOptions(directory, session.id, model)).options
    assert.ok(options.find((option) => option.id === "model")?.selectOptions?.some((option) => option.id === model))
    assert.ok(options.find((option) => option.id === "effort")?.selectOptions?.some((option) => option.id === "high"))
    const requests = await changeDuringTool(stack, api, directory, session.id, harness, `LIVEMODEL${harness.toUpperCase()}`, async () => {
      await refusedSettings(api, directory, session.id, harness)
      await api.updateSessionConfig(directory, session.id, { variant: "high" })
      await api.updateSessionConfig(directory, session.id, { variant: "high" })
      await api.updateSessionConfig(directory, session.id, { model: { providerID: provider, modelID: model } })
      assert.equal((await api.sessionConfig(directory, session.id)).variant, "high", "A model-only change keeps an effort the new model offers")
    })
    assert.notEqual(requests[0]?.model, requests.at(-1)?.model)
    assert.equal(effort(requests.at(-1), harness), "high")
    await resetEffort(stack, api, directory, harness, model, options.find((option) => option.id === "effort")?.currentValue)
    console.log(`H10 ${harness}: live model, effort-only, reset and refusal recovery passed`)
  } finally { await stack.close() }
}

export async function run() {
  await liveModelSettings("claude")
  await liveModelSettings("codex")
}
