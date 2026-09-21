import { expect, test } from "bun:test"
import type { PromptInput } from "../../index"
import type { ActiveTurn } from "./sdk-runtime-driver"
import { createSessionTurnLifecycle } from "./turn-lifecycle"
import { steerActiveTurn } from "./turn-steering"

const prompt: PromptInput = {
  parts: [{ type: "text", text: "S" }], userMessageId: "message-S", assistantMessageId: "reply-S",
  agent: "build", model: { providerID: "test", modelID: "test" },
}

test("an active turn without a steering protocol explicitly reports unsupported", async () => {
  const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
  lifecycle.set("session", { abort: new AbortController() })
  expect(await steerActiveTurn(lifecycle, "session", prompt)).toMatchObject({ ok: false, status: "unsupported" })
})

test("a transport error after dispatch cannot be treated as a provider rejection", async () => {
  const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
  lifecycle.set("session", { abort: new AbortController(), steer: async () => { throw new Error("Connection lost") } })
  expect(await steerActiveTurn(lifecycle, "session", prompt)).toEqual({ ok: false, status: "unknown", message: "Connection lost" })
})

test("the adapter preserves an explicit provider refusal", async () => {
  const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
  lifecycle.set("session", { abort: new AbortController(), steer: async () => ({ ok: false, status: "declined", message: "Review turns cannot accept input" }) })
  expect(await steerActiveTurn(lifecycle, "session", prompt)).toEqual({ ok: false, status: "declined", message: "Review turns cannot accept input" })
})
