import { expect, test } from "bun:test"
import type { TurnBroker, TurnInput } from "../../contract"
import { scriptedPi } from "./test-support/scripted-pi"

const LEVELS: Record<string, string[]> = { "scripted/deep": ["off", "low", "high"], "scripted/fast": ["off"] }
const FRESH = { model: "scripted/deep", level: "low" }

function scriptedCatalog(sessionSetModel?: Promise<void>) {
  const states = new Map<object, { model: string; level: string }>()
  return (frame: { type: string; provider?: string; modelId?: string; level?: string }, launch: { options: { role?: string } }) => {
    const state = states.get(launch) ?? { ...FRESH }
    states.set(launch, state)
    if (frame.type === "get_available_models") {
      return { models: Object.keys(LEVELS).map((id) => ({ provider: "scripted", id: id.slice("scripted/".length), name: id })) }
    }
    if (frame.type === "get_available_thinking_levels") return { levels: LEVELS[state.model] }
    if (frame.type === "set_model") {
      state.model = `${frame.provider}/${frame.modelId}`
      if (!LEVELS[state.model]?.includes(state.level)) state.level = "off"
      return launch.options.role === "probe" || !sessionSetModel ? {} : sessionSetModel.then(() => ({}))
    }
    if (frame.type === "set_thinking_level") {
      if (LEVELS[state.model]?.includes(frame.level ?? "")) state.level = frame.level!
      return {}
    }
    if (frame.type === "get_state") {
      const [provider, id] = state.model.split("/")
      return { sessionId: "scripted-pi", thinkingLevel: state.level, model: { provider, id } }
    }
    return undefined
  }
}

const deep = { providerID: "pi", modelID: "scripted/deep" }
const fast = { providerID: "pi", modelID: "scripted/fast" }

function configFrames(frames: readonly { type: string; provider?: string; modelId?: string; level?: string }[]) {
  return frames.filter((frame) => ["set_model", "set_thinking_level", "get_state", "prompt"].includes(frame.type))
    .map((frame) => frame.type === "set_model" ? `set_model ${frame.modelId}` : frame.type === "set_thinking_level" ? `level ${frame.level}` : frame.type)
}

test("a live Pi change and a starting turn's config take the session RPC one at a time", async () => {
  const held = Promise.withResolvers<void>()
  const pi = await scriptedPi({ respond: scriptedCatalog(held.promise) })
  try {
    const session = await pi.transport.start(pi.start(), pi.broker)
    const wire = pi.launches.find((launch) => launch.options.role !== "probe")!.wire
    const before = wire.received.length
    const live = pi.transport.config.setModelSettings!(session, { model: deep, effort: "high" })
    const deadline = Date.now() + 2_000
    while (!wire.received.slice(before).some((frame) => frame.type === "set_model") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [], model: fast, effort: "off",
      origin: { actor: pi.start().owner, via: "loopback", reissued: false },
      prompt: { agent: "pi", assistantMessageId: "a1", parts: [{ type: "text", text: "continue" }] } }
    const running = (async () => {
      for await (const _event of pi.transport.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {}
    })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(configFrames(wire.received.slice(before))).toEqual(["set_model deep"])
    held.resolve()
    await live
    await running
    expect(configFrames(wire.received.slice(before))).toEqual([
      "set_model deep", "level high", "get_state", "set_model fast", "level off", "get_state", "prompt",
    ])
  } finally { held.resolve(); await pi.close() }
})

test("a Pi change is validated before the session moves, and a cleared effort applies the level a fresh Pi runs the model at", async () => {
  const pi = await scriptedPi({ respond: scriptedCatalog() })
  try {
    const session = await pi.transport.start(pi.start(), pi.broker)
    const wire = pi.launches.find((launch) => launch.options.role !== "probe")!.wire
    await pi.transport.config.setModelSettings!(session, { model: deep, effort: "high" })
    const before = wire.received.length
    await expect(pi.transport.config.setModelSettings!(session, { model: fast, effort: "high" })).rejects.toThrow("thinking level high")
    await expect(pi.transport.config.setModelSettings!(session, { effort: "low" })).rejects.toThrow("Pi requires a model")
    await expect(pi.transport.config.setModelSettings!(session, { model: { providerID: "pi", modelID: "default" } }))
      .rejects.toThrow("provider/model key")
    expect(configFrames(wire.received.slice(before))).toEqual([])
    await pi.transport.config.setModelSettings!(session, { model: deep, effort: null })
    expect(configFrames(wire.received.slice(before))).toEqual(["set_model deep", "level low", "get_state"])
  } finally { await pi.close() }
})
