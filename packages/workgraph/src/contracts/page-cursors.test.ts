import { describe, expect, it } from "vitest"
import {
  WorkSourcePageCursorError,
  createWorkSourcePageCursor,
  readWorkSourcePageCursor,
} from "./page-cursors"

describe("tenant-bound page cursors", () => {
  it("round-trips stable Work Source keyset positions", () => {
    const source = createWorkSourcePageCursor({ organizationId: "org_a", ownerUserId: "owner_a", createdAt: 10, sourceId: "source_a" })

    expect(readWorkSourcePageCursor(source, "org_a", "owner_a")).toEqual({ createdAt: 10, sourceId: "source_a" })
  })

  it("rejects cross-organization same-user reuse", () => {
    const source = createWorkSourcePageCursor({ organizationId: "org_a", ownerUserId: "same_user", createdAt: 10, sourceId: "source_a" })

    expect(() => readWorkSourcePageCursor(source, "org_b", "same_user"))
      .toThrow(expect.objectContaining<Partial<WorkSourcePageCursorError>>({ reason: "owner_mismatch" }))
  })
})
