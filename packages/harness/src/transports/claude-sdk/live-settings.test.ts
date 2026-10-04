import { expect, test } from "bun:test"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import { ClaudeLiveQuery } from "./live-query"
import { applyClaudeLiveSettings, type ClaudeLiveSettings } from "./live-settings"
import { background, collect, init, input, rebound, result, setup, turnBroker, until, userTurn } from "./test-support/live"

test("effort changes and explicit reset apply through the SDK without rewriting unchanged settings", async () => {
  const calls: unknown[] = []
  const query = { applyFlagSettings: async (settings: unknown) => { calls.push(settings) } } as Query
  const current = { model: "sonnet", effort: "high" as const }
  await applyClaudeLiveSettings(query, current, { ...current })
  await applyClaudeLiveSettings(query, current, { model: "sonnet", effort: "low" })
  await applyClaudeLiveSettings(query, current, { model: "sonnet" })
  expect(calls).toEqual([{ effortLevel: "low" }, { effortLevel: null }])
})

test("a rejected SDK setting remains unapplied and does not close the process", async () => {
  const current = { model: "sonnet", effort: "high" as const }
  const query = { applyFlagSettings: async () => { throw new Error("refused") } } as unknown as Query
  await expect(applyClaudeLiveSettings(query, current, { model: "sonnet", effort: "low" })).rejects.toThrow("refused")
  expect(current.effort).toBe("high")
})

test("combined model and effort changes wait for launch, remain unapplied on refusal, and recover without interrupting", async () => {
  const current: ClaudeLiveSettings = { model: "sonnet", effort: "high" }
  const frames = new AsyncPushQueue<SDKMessage>()
  const live = new ClaudeLiveQuery("key", { unclaimed() {}, stage: () => async () => {}, background() {} }, current)
  const calls: unknown[] = []
  const stream = { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), async applyFlagSettings(settings: unknown) {
    calls.push(settings)
    if (calls.length === 1) throw new Error("native refusal")
  } } as unknown as Query
  const updating = live.setModelSettings({ model: "opus", effort: "low" })
  expect(calls).toEqual([])
  live.run(stream)
  const claim = live.claim("result")!
  await expect(updating).rejects.toMatchObject({ code: "configuration" })
  expect(current).toEqual({ model: "sonnet", effort: "high" })
  await live.setModelSettings({ model: "opus", effort: "low" })
  expect(current).toEqual({ model: "opus", effort: "low" })
  expect(calls).toEqual([{ model: "opus", effortLevel: "low" }, { model: "opus", effortLevel: "low" }])
  frames.push(result())
  for await (const _frame of claim.frames) {}
  frames.end()
  await live.ended
})

test("the last background task finishing during a setting control cannot close the next prompt's stdin", async () => {
  const frames = new AsyncPushQueue<SDKMessage>()
  const live = new ClaudeLiveQuery("key", { unclaimed() {}, stage: () => async () => {}, background() {} }, { model: "sonnet", effort: "high" })
  const stream = { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), applyFlagSettings: async () => {
    frames.push(background())
    await until(() => !live.hasBackgroundTasks)
  } } as unknown as Query
  live.run(stream)
  frames.push(background("job"))
  await until(() => live.hasBackgroundTasks)
  const opening: SDKUserMessage = { type: "user", session_id: "", message: { role: "user", content: "next" }, parent_tool_use_id: null }
  const claim = await live.prompt(opening, "a-next", { model: "sonnet", effort: "low" })
  const next = await live.input.stream[Symbol.asyncIterator]().next()
  expect(next.done).toBe(false)
  frames.push({ ...next.value!, isReplay: true } as SDKMessage)
  frames.push(result())
  const received: SDKMessage[] = []
  for await (const event of claim.frames) received.push(event as SDKMessage)
  expect(received.at(-1)?.type).toBe("result")
  frames.end()
  await live.ended
})

test("unchanged configure pushes and session metadata keep background work on the same process", async () => {
  const f = await setup()
  try {
    const first = collect(f.transport.send(f.session, userTurn("t1", "start"), turnBroker()))
    await until(() => f.launches[0]?.prompts.length === 1)
    const claude = f.launches[0]!
    claude.frames.push(init())
    claude.replay(0)
    claude.frames.push(background("job"))
    claude.frames.push(result())
    await first
    await f.transport.configure(rebound(f.session), { credentials: structuredClone(input.credentials), projection: structuredClone(input.projection) })
    const config = f.broker.config()
    f.broker.config = () => ({ ...config, permissionModeLabel: "Updated label" })
    const second = collect(f.transport.send(rebound(f.session), userTurn("t2", "continue"), turnBroker()))
    await until(() => claude.prompts.length === 2)
    claude.replay(1)
    claude.frames.push(result())
    await second
    expect(f.launches).toHaveLength(1)
    expect(claude.controls).toEqual([])
    expect(claude.stdinOpen()).toBe(true)
  } finally { await f.transport.dispose() }
})

test("a launch-only change refuses the new turn and leaves background jobs usable", async () => {
  const f = await setup()
  try {
    const first = collect(f.transport.send(f.session, userTurn("t1", "start"), turnBroker()))
    await until(() => f.launches[0]?.prompts.length === 1)
    const claude = f.launches[0]!
    claude.frames.push(init())
    claude.replay(0)
    claude.frames.push(background("job"))
    claude.frames.push(result())
    await first
    await expect(collect(f.transport.send(rebound(f.session), { ...userTurn("t2", "change"), system: "new instructions" }, turnBroker())))
      .rejects.toThrow("background tasks are running")
    expect(claude.controls).toEqual([])
    expect(claude.stdinOpen()).toBe(true)
    const third = collect(f.transport.send(rebound(f.session), userTurn("t3", "continue"), turnBroker()))
    await until(() => claude.prompts.length === 2)
    claude.replay(1)
    claude.frames.push(result())
    await third
    expect(f.launches).toHaveLength(1)
  } finally { await f.transport.dispose() }
})

test("a rejected setting leaves background permissions on the session broker and the process usable", async () => {
  const f = await setup({ failModel: new Error("model refused") })
  try {
    const first = collect(f.transport.send(f.session, userTurn("t1", "start"), turnBroker()))
    await until(() => f.launches[0]?.prompts.length === 1)
    const claude = f.launches[0]!
    claude.frames.push(init())
    claude.replay(0)
    claude.frames.push(background("job"))
    claude.frames.push(result())
    await first
    await expect(collect(f.transport.send(rebound(f.session), userTurn("t2", "change", "sonnet"), turnBroker()))).rejects.toThrow("model refused")
    expect(claude.turn()).toBeUndefined()
    expect(claude.stdinOpen()).toBe(true)
    expect(claude.controls).toEqual(['settings {"model":"sonnet","effortLevel":null}'])
    const third = collect(f.transport.send(rebound(f.session), userTurn("t3", "continue"), turnBroker()))
    await until(() => claude.prompts.length === 2)
    claude.replay(1)
    claude.frames.push(result())
    await third
    expect(f.launches).toHaveLength(1)
  } finally { await f.transport.dispose() }
})
