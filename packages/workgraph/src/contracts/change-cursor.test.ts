import { describe, expect, it } from "vitest"
import { ChangeCursorError, createChangeCursor, readChangeCursor } from "./change-cursor"

describe("ChangeCursor", () => {
  it("round-trips an organization, owner, and filter-bound position", () => {
    const all = createChangeCursor({ organizationId: "org:one", ownerUserId: "user@example.com", position: 42 })
    const stream = createChangeCursor({
      organizationId: "org:one",
      ownerUserId: "user@example.com",
      scope: { type: "stream", streamId: "stream/one" },
      position: 41,
    })

    expect(readChangeCursor(all, "org:one", "user@example.com")).toBe(42)
    expect(readChangeCursor(stream, "org:one", "user@example.com", { type: "stream", streamId: "stream/one" })).toBe(41)
  })

  it("rejects cross-organization same-user, cross-owner, cross-filter, and malformed reuse", () => {
    const all = createChangeCursor({ organizationId: "org_a", ownerUserId: "same_user", position: 2 })
    const stream = createChangeCursor({
      organizationId: "org_a",
      ownerUserId: "same_user",
      scope: { type: "stream", streamId: "stream_a" },
      position: 2,
    })

    expect(() => readChangeCursor(all, "org_b", "same_user")).toThrow(expect.objectContaining<Partial<ChangeCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readChangeCursor(all, "org_a", "other_user")).toThrow(expect.objectContaining<Partial<ChangeCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readChangeCursor(stream, "org_a", "same_user", { type: "stream", streamId: "stream_b" }))
      .toThrow(expect.objectContaining<Partial<ChangeCursorError>>({ reason: "filter_mismatch" }))
    expect(() => readChangeCursor("broken", "org_a", "same_user")).toThrow(expect.objectContaining<Partial<ChangeCursorError>>({ reason: "invalid" }))
  })
})
