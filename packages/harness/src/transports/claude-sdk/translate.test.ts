import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnBroker } from "../../contract"
import { claudeTranslator, translateClaude } from "./translate"

test("an unknown Claude SDK message becomes a bounded unrecognized diagnostic", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const broker = { observeSubagent: async () => undefined } as unknown as TurnBroker
  const payload = { type: "future_event", body: "x".repeat(10_000) } as unknown as SDKMessage
  const events = await translateClaude(payload, runtime, tasks, broker)
  expect(events[0]?.event.type).toBe("diagnostic")
  if (events[0]?.event.type === "diagnostic") {
    expect(events[0].event.diagnostic.code).toBe("unrecognized-event")
    expect(typeof events[0].event.diagnostic.raw).toBe("string")
    if (typeof events[0].event.diagnostic.raw === "string") expect(Buffer.byteLength(events[0].event.diagnostic.raw)).toBeLessThanOrEqual(4096)
  }
})
