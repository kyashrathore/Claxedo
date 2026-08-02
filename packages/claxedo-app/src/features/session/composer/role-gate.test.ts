import { describe, expect, test } from "bun:test"
import type { Placement, RelayRole } from "@/platform/runtime/placement"
import { submitBlockedByRole } from "./role-gate"

describe("submitBlockedByRole", () => {
  const placement = (role?: RelayRole): Placement => ({
    workspaceId: "ws_1",
    hosting: "workspace",
    transport: "workspace-relay",
    ...(role ? { role } : {}),
  })

  test("blocks viewer and role-less placements", () => {
    expect(submitBlockedByRole(placement("viewer"))).toBe(true)
    expect(submitBlockedByRole(placement())).toBe(true)
  })

  test("allows editor, admin, owner, and unknown authority", () => {
    expect(submitBlockedByRole(placement("editor"))).toBe(false)
    expect(submitBlockedByRole(placement("admin"))).toBe(false)
    expect(submitBlockedByRole(placement("owner"))).toBe(false)
    expect(submitBlockedByRole(undefined)).toBe(false)
  })
})
