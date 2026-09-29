import { describe, expect, test } from "vitest"
import { AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import { parseMessagePageInput, parseSessionPartInput } from "./message-page"

describe("message page input", () => {
  test("accepts the semantic views by themselves, and a whole turn before a cursor", () => {
    expect(parseMessagePageInput(undefined, undefined, "latest-turn")).toEqual({ view: "latest-turn" })
    expect(parseMessagePageInput(undefined, undefined, "latest-surface")).toEqual({ view: "latest-surface" })
    expect(parseMessagePageInput(undefined, "cursor", "latest-turn")).toEqual({ view: "latest-turn", before: "cursor" })
  })

  test("rejects unknown or mixed semantic views", () => {
    expect(() => parseMessagePageInput(undefined, undefined, "latest-message")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput("20", undefined, "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput(undefined, "", "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput(undefined, "cursor", "latest-surface")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageInput("20", undefined, "latest-surface")).toThrow(AgentMessagePageError)
  })
})

describe("session part input", () => {
  test("names the message and the part inside it, and refuses a read missing either", () => {
    expect(parseSessionPartInput("msg_1", "prt_1")).toEqual({ messageId: "msg_1", partId: "prt_1" })
    for (const [messageId, partId] of [[undefined, "prt_1"], ["msg_1", undefined], ["", "prt_1"], ["msg_1", ""]]) {
      expect(() => parseSessionPartInput(messageId, partId)).toThrow(AgentMessagePageError)
    }
  })
})
