import { describe, expect, test } from "vitest"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { parseMessagePageInput } from "./message-page"

describe("message page input", () => {
  test("accepts the semantic latest-turn view by itself", () => {
    expect(parseMessagePageInput(undefined, undefined, "latest-turn")).toEqual({ view: "latest-turn" })
    expect(parseMessagePageInput(undefined, undefined, "latest-surface")).toEqual({ view: "latest-surface" })
  })

  test("rejects unknown or mixed semantic views", () => {
    expect(() => parseMessagePageInput(undefined, undefined, "latest-message")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput("20", undefined, "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput(undefined, "cursor", "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput("20", undefined, "latest-surface")).toThrow(AgentMessagePageError)
  })
})
