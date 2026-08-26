import { describe, expect, test } from "bun:test"
import {
  fullHydrationPartCoverage,
  isDestinationMessageResponse,
  responseSurfaceStructure,
} from "../src/message-response-observer"

describe("message response observation", () => {
  test("matches only the destination session message endpoint", () => {
    expect(isDestinationMessageResponse(
      "http://127.0.0.1:4096/session/ses_actual_123/message?view=latest-surface",
      "ses_actual_123",
    )).toBe(true)
    expect(isDestinationMessageResponse(
      "http://127.0.0.1:4096/session/ses_actual_other/message?view=latest-surface",
      "ses_actual_123",
    )).toBe(false)
    expect(isDestinationMessageResponse(
      "http://127.0.0.1:4096/session/ses_actual_123/todo",
      "ses_actual_123",
    )).toBe(false)
  })

  test("matches encoded canonical session ids without exposing the full URL", () => {
    expect(isDestinationMessageResponse(
      "http://localhost/session/ses%20actual/message",
      "ses actual",
    )).toBe(true)
    expect(isDestinationMessageResponse("not a URL", "ses actual")).toBe(false)
  })

  test("distinguishes the first-paint projection from eventual full-turn completion", () => {
    const url = "http://localhost/session/ses_actual/message?directory=%2Fprivate&view=latest-turn"
    expect(isDestinationMessageResponse(url, "ses_actual", "latest-turn")).toBe(true)
    expect(isDestinationMessageResponse(url, "ses_actual", "latest-surface")).toBe(false)
  })

  test("reduces a first-surface response to roles and byte counts without content or identities", () => {
    const body = Buffer.from(JSON.stringify([
      { info: { id: "private-message", role: "assistant" }, parts: [
        { id: "private-part", type: "text", text: "private text" },
        { type: "tool", state: { output: "private tool output" } },
      ] },
    ]))
    const structure = responseSurfaceStructure(body)
    expect(structure).toEqual([{
      role: "assistant",
      serializedBytes: body.byteLength - 2,
      fields: [{ name: "role", serializedBytes: 11 }],
      parts: [
        { type: "text", serializedBytes: 57, textBytes: 12, outputBytes: 0 },
        { type: "tool", serializedBytes: 56, textBytes: 0, outputBytes: 19 },
      ],
    }])
    expect(JSON.stringify(structure)).not.toContain("private")
  })

  test("reports eventual full-part coverage as counts without returning identities", () => {
    const body = Buffer.from(JSON.stringify([
      { parts: [{ id: "private-part-1", type: "text" }, { id: "private-part-2", type: "tool" }] },
    ]))
    const coverage = fullHydrationPartCoverage(body, ["private-part-1", "private-part-2", "missing-private-part"])
    expect(coverage).toEqual({ expectedPartCount: 3, observedPartCount: 2, missingPartCount: 1 })
    expect(JSON.stringify(coverage)).not.toContain("private-part")
  })
})
