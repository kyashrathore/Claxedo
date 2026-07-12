import { describe, expect, test } from "bun:test"
import type { Placement, RelayRole } from "@/platform/runtime/placement"
import { terminalBlockedByRole } from "./terminal-role-gate"

function placement(role: RelayRole): Placement {
  return {
    workspaceId: "ws_1",
    hosting: "workspace",
    transport: "workspace-relay",
    role,
  }
}

describe("terminalBlockedByRole", () => {
  test("blocks viewers from terminal access", () => {
    expect(terminalBlockedByRole(placement("viewer"))).toBe(true)
  })

  test("allows terminal access for write roles and local placements", () => {
    expect(terminalBlockedByRole(placement("editor"))).toBe(false)
    expect(terminalBlockedByRole(placement("admin"))).toBe(false)
    expect(terminalBlockedByRole(placement("owner"))).toBe(false)
    expect(terminalBlockedByRole(undefined)).toBe(false)
  })
})
