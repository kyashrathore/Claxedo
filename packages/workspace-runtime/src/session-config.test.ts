import { describe, expect, test } from "bun:test"
import {
  normalizeSessionCreateBody,
  sessionInstructionsByteLength,
  SESSION_INSTRUCTIONS_MAX_BYTES,
} from "./session-config"

describe("normalizeSessionCreateBody", () => {
  test("keeps only the create fields the routes read", () => {
    expect(normalizeSessionCreateBody({
      id: "ses_1",
      title: "Hybrid",
      parentID: "ses_parent",
      role: "reviewer",
      clientRequestId: "req_1",
      permissionCeiling: "ask",
      permissionMode: "plan",
      instructions: "Answer only in haiku.",
      unknown: "dropped",
    })).toEqual({
      id: "ses_1",
      title: "Hybrid",
      parentID: "ses_parent",
      role: "reviewer",
      clientRequestId: "req_1",
      permissionCeiling: "ask",
      permissionMode: "plan",
      instructions: "Answer only in haiku.",
    })
  })

  test("omits instructions a caller did not send or sent as a non-string", () => {
    expect(normalizeSessionCreateBody({})).toEqual({})
    expect(normalizeSessionCreateBody({ instructions: 12 })).toEqual({})
    expect(normalizeSessionCreateBody({ instructions: "" })).toEqual({})
    expect(normalizeSessionCreateBody(undefined)).toEqual({})
  })
})

describe("sessionInstructionsByteLength", () => {
  test("measures UTF-8 bytes, not code units, against the create cap", () => {
    expect(sessionInstructionsByteLength("abc")).toBe(3)
    expect(sessionInstructionsByteLength("é")).toBe(2)
    expect(sessionInstructionsByteLength("🙂")).toBe(4)
    expect(sessionInstructionsByteLength("🙂".repeat(SESSION_INSTRUCTIONS_MAX_BYTES / 4)))
      .toBe(SESSION_INSTRUCTIONS_MAX_BYTES)
    expect(SESSION_INSTRUCTIONS_MAX_BYTES).toBe(65_536)
  })
})
