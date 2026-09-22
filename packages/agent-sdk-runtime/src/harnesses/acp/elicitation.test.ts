import { describe, expect, test } from "bun:test"
import { MemoryRuntimeStore } from "../../stores/memory"
import { AcpElicitationInteractions } from "./elicitation"
import { createElicitationPatternEvaluator } from "./pattern-validation"

function fixture() {
  const store = new MemoryRuntimeStore()
  store.bindSession({ sessionId: "local", directory: "/repo", agentSessionId: "remote" })
  const events: string[] = []
  const interactions = new AcpElicitationInteractions(store, (_, event) => events.push(event.type))
  const scope = { sessionId: "local", agentSessionId: "remote", directory: "/repo", agentName: "Example agent" }
  const binding = { sessionId: "local", upstreamSessionId: "remote", directory: "/repo", connectionId: "connection", workspaceId: "workspace" }
  const form = { mode: "form", message: "Choose settings", requestedSchema: { type: "object", properties: {
    count: { type: "integer", minimum: 1, maximum: 5 },
    approach: { type: "string", oneOf: [{ const: "safe", title: "Careful" }, { const: "fast" }] },
  }, required: ["count", "approach"] } }
  return { store, events, interactions, scope, binding, form, id: () => store.listQuestions("/repo")[0].id }
}

describe("ACP elicitation", () => {
  test("durably presents a typed form, validates without consuming it, and replies exactly once", async () => {
    const f = fixture()
    const response = f.interactions.create({ ...f.scope, params: f.form })
    expect(f.store.listQuestions("/repo")[0]?.questions[0]).toMatchObject({ custom: true, question: expect.stringContaining("Choose settings") })
    expect(() => f.interactions.reply(f.binding, f.id(), [["{}"]])).toThrow("required")
    expect(f.interactions.list("/repo")).toHaveLength(1)
    expect(() => f.interactions.reply({ ...f.binding, sessionId: "other" }, f.id(), [["{}"]])).toThrow("does not belong")
    const id = f.id()
    await f.interactions.reply(f.binding, id, [[JSON.stringify({ count: 2, approach: "safe" })]])
    expect(await response).toEqual({ action: "accept", content: { count: 2, approach: "safe" } })
    expect(f.events).toEqual(["question.asked", "question.replied"])
    expect(f.store.listQuestions("/repo")).toEqual([])
    expect(() => f.interactions.reply(f.binding, id, [])).toThrow("no longer connected")
  })
  test("distinguishes decline, dismissal, and process loss", async () => {
    const f = fixture()
    const declined = f.interactions.create({ ...f.scope, params: f.form })
    f.interactions.reject(f.binding, f.id())
    expect(await declined).toEqual({ action: "decline" })
    const cancelled = f.interactions.create({ ...f.scope, params: f.form })
    await f.interactions.reply(f.binding, f.id(), [])
    expect(await cancelled).toEqual({ action: "cancel" })
    const controller = new AbortController()
    const lost = f.interactions.create({ ...f.scope, params: f.form, signal: controller.signal })
    controller.abort()
    expect(await lost).toEqual({ action: "cancel" })
    expect(f.store.listQuestions("/repo")).toEqual([])
  })
  test("URL acceptance is consent only and URL IDs remain outstanding until completion", async () => {
    const f = fixture()
    const params = { mode: "url", message: "Connect account", url: "https://example.com/oauth", elicitationId: "auth-one" }
    const response = f.interactions.create({ ...f.scope, params })
    expect(() => f.interactions.reply(f.binding, f.id(), [["done"]])).toThrow("explicit consent")
    await f.interactions.reply(f.binding, f.id(), [["I've finished connecting"]])
    expect(await response).toEqual({ action: "accept" })
    expect(() => f.interactions.create({ ...f.scope, params })).toThrow("Duplicate")
    f.interactions.complete("unknown")
    f.interactions.complete("auth-one")
    const next = f.interactions.create({ ...f.scope, params })
    f.interactions.dispose()
    expect(await next).toEqual({ action: "cancel" })
  })
  test("rejects unsupported modes, nested forms and active-content URLs without persisting a question", () => {
    const f = fixture()
    for (const params of [
      { mode: "future", message: "Unsupported" },
      { mode: "url", message: "Bad URL", url: "javascript:alert(1)", elicitationId: "bad" },
      { mode: "form", message: "Nested", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } },
    ]) expect(() => f.interactions.create({ ...f.scope, params })).toThrow()
    expect(f.store.listQuestions("/repo")).toEqual([])
  })
})

test("pattern mismatch and timeout preserve the durable question for a valid retry", async () => {
  const f = fixture()
  const interactions = new AcpElicitationInteractions(f.store, (_, event) => f.events.push(event.type), createElicitationPatternEvaluator({ executionMs: 15 }))
  const response = interactions.create({ ...f.scope, params: { mode: "form", message: "Pattern", requestedSchema: { type: "object", properties: { answer: { type: "string", pattern: "^(a+)+$" } }, required: ["answer"] } } })
  for (let n = 0; n < 100 && !f.store.listQuestions("/repo").length; n++) await Bun.sleep(5)
  const id = f.id()
  await expect(interactions.reply(f.binding, id, [[JSON.stringify({ answer: "b" })]])).rejects.toMatchObject({ code: "invalid_answer" })
  await expect(interactions.reply(f.binding, id, [[JSON.stringify({ answer: "a".repeat(32000) + "!" })]])).rejects.toMatchObject({ code: "validation_timeout" })
  expect(f.store.listQuestions("/repo")).toHaveLength(1)
  expect(f.events).toEqual(["question.asked"])
  await interactions.reply(f.binding, id, [[JSON.stringify({ answer: "aaa" })]])
  expect(await response).toEqual({ action: "accept", content: { answer: "aaa" } })
  expect(f.events).toEqual(["question.asked", "question.replied"])
  interactions.dispose(); f.interactions.dispose()
})

test("question cancellation defeats an in-flight validation and duplicate acceptance", async () => {
  const f = fixture()
  let release!: () => void
  let calls = 0
  const interactions = new AcpElicitationInteractions(f.store, (_, event) => f.events.push(event.type), async () => {
    if (++calls === 1) return
    await new Promise<void>((resolve) => { release = resolve })
  })
  const response = interactions.create({ ...f.scope, params: { mode: "form", message: "Pattern", requestedSchema: { type: "object", properties: { answer: { type: "string", pattern: "." } } } } })
  await Bun.sleep(0)
  const id = f.id()
  const validating = interactions.reply(f.binding, id, [['{"answer":"yes"}']])
  await expect(interactions.reply(f.binding, id, [['{"answer":"yes"}']])).rejects.toMatchObject({ code: "validation_busy" })
  interactions.dispose()
  release()
  await expect(validating).rejects.toMatchObject({ code: "validation_cancelled" })
  expect(await response).toEqual({ action: "cancel" })
  expect(f.events).toEqual(["question.asked", "question.replied"])
  expect(f.store.listQuestions("/repo")).toEqual([])
  f.interactions.dispose()
})

test("invalid pattern schema never publishes a question", async () => {
  const f = fixture()
  await expect(f.interactions.create({ ...f.scope, params: { mode: "form", message: "Pattern", requestedSchema: { type: "object", properties: { answer: { type: "string", pattern: "[" } } } } })).rejects.toMatchObject({ code: "invalid_schema" })
  expect(f.events).toEqual([])
  f.interactions.dispose()
})

test("ACP shared question settlement retains its live resolver after a failed durable reply", async () => {
  const f = fixture()
  const response = f.interactions.create({ ...f.scope, params: f.form })
  const id = f.id()
  const append = f.store.appendEvent.bind(f.store)
  f.store.appendEvent = () => { throw new Error("fixture write failure") }
  await expect(f.interactions.reply(f.binding, id, [[JSON.stringify({ count: 2, approach: "safe" })]])).rejects.toThrow("fixture write failure")
  expect(f.interactions.owns(id)).toBe(true)
  expect(f.store.listQuestions("/repo")).toHaveLength(1)
  expect(f.events).toEqual(["question.asked"])
  f.store.appendEvent = append
  await f.interactions.reply(f.binding, id, [[JSON.stringify({ count: 2, approach: "safe" })]])
  expect(await response).toEqual({ action: "accept", content: { count: 2, approach: "safe" } })
  expect(f.events).toEqual(["question.asked", "question.replied"])
})
