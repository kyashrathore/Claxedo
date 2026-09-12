import { describe, expect, test } from "bun:test"
import {
  normalizeSessionConfigUpdate,
  normalizeSessionCreateBody,
  sessionCreateGroup,
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

describe("sessionCreateGroup", () => {
  const slot = {
    harness: { id: "claude", access: "native" },
    model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
    effort: "max",
  }

  test("answers undefined only when the caller sent no group at all", () => {
    expect(sessionCreateGroup({ instructions: "x" })).toBeUndefined()
    expect(sessionCreateGroup(undefined)).toBeUndefined()
    expect(sessionCreateGroup({ group: {} })).toEqual({ group: {} })
  })

  test("carries the parsed slots through the create body", () => {
    expect(sessionCreateGroup({ group: { primary: slot } })).toEqual({
      group: { primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "claude-opus-4-1" }, effort: "max" } },
    })
  })

  test("returns the failing field so the route can name it instead of dropping the slot", () => {
    expect(sessionCreateGroup({ group: { primary: { harness: "claude" } } })).toMatchObject({ field: "group.primary.model" })
    expect(sessionCreateGroup({ group: 7 })).toMatchObject({ field: "group" })
  })

  test("a config update never carries a group, so a PATCH cannot rewrite one", () => {
    expect(normalizeSessionConfigUpdate({ harness: { id: "claude", access: "native" }, group: { primary: slot } }))
      .toEqual({ harness: { id: "claude", access: "native" } })
  })
})
