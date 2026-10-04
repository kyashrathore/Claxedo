import { expect, test } from "bun:test"
import type { TurnBroker, TurnInput } from "../../contract"
import { scriptedTransport } from "./test-support/transport"

test("live settings wait for turn startup, recover from native refusal, and leave turn and process intact", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true, turnSettingsFailures: 1, models: [
    { model: "alpha", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { model: "beta", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  ] })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [],
      origin: { actor: peer.startInput.owner, via: "loopback", reissued: false },
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "continue working" }] } }
    const running = (async () => { for await (const _event of peer.transport.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    const requested = { model: { providerID: "codex", modelID: "beta" }, effort: "high" }
    const updating = peer.transport.config.setModelSettings!(session, requested)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peer.frames.some((frame) => frame.method === "turn/settings/update")).toBe(false)
    peer.releaseTurnStart()
    await expect(updating).rejects.toThrow("native live settings refused")
    expect(peer.frames.some((frame) => frame.method === "thread/settings/update")).toBe(false)
    await peer.transport.config.setModelSettings!(session, requested)
    expect(peer.frames.filter((frame) => frame.method === "turn/settings/update").at(-1)?.params).toEqual({
      threadId: "thread-1", turnId: "turn-current", model: "beta", effort: "high",
    })
    expect(peer.frames.find((frame) => frame.method === "thread/settings/update")?.params).toEqual({ threadId: "thread-1", model: "beta", effort: "high" })
    expect(peer.frames.filter((frame) => frame.method === "turn/start")).toHaveLength(1)
    expect(peer.frames.some((frame) => frame.method === "turn/interrupt")).toBe(false)
    expect(peer.retired()).toBe(0)
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await running
    await peer.transport.config.setModelSettings!(session, { model: requested.model, effort: null })
    expect(peer.frames.filter((frame) => frame.method === "thread/settings/update").at(-1)?.params?.effort).toBe("medium")
    expect(peer.spawned()).toBe(1)
  } finally { await peer.close() }
})

test("a turn whose start fails does not fail a live settings change, which still reaches future turns", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true, models: [
    { model: "alpha", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { model: "beta", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  ] })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [],
      origin: { actor: peer.startInput.owner, via: "loopback", reissued: false },
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "continue working" }] } }
    const running = (async () => { for await (const _event of peer.transport.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {} })()
    const failed = running.then(() => undefined, (error: unknown) => error)
    await peer.started
    const updating = peer.transport.config.setModelSettings!(session, { model: { providerID: "codex", modelID: "beta" }, effort: "high" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    peer.releaseTurnStart("turn start refused")
    expect(String(await failed)).toContain("turn start refused")
    await updating
    expect(peer.frames.some((frame) => frame.method === "turn/settings/update")).toBe(false)
    expect(peer.frames.find((frame) => frame.method === "thread/settings/update")?.params).toEqual({ threadId: "thread-1", model: "beta", effort: "high" })
  } finally { await peer.close() }
})
