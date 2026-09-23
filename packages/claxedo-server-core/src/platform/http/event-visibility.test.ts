import { describe, expect, test } from "vitest"
import { eventVisibleTo } from "./event-visibility"

describe("control-plane event visibility", () => {
  test("the quota doorbell reaches every subscriber, signed in any org or none", () => {
    const event = { type: "usage.quota.changed", ts: 1 } as const
    expect(eventVisibleTo({ mode: "unsigned-local" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_a", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b" }, event)).toBe(true)
  })

  test("an org-scoped doorbell still stops at its org", () => {
    const event = { type: "session.inventory.changed", workspaceId: "ws", orgId: "org_a", ts: 1 } as const
    expect(eventVisibleTo({ mode: "signed", subject: "user_a", orgId: "org_a" }, event)).toBe(true)
    expect(eventVisibleTo({ mode: "signed", subject: "user_b", orgId: "org_b" }, event)).toBe(false)
  })
})
