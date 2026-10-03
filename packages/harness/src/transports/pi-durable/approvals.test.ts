import { expect, test } from "bun:test"
import { piPermissionMode } from "./approvals"

test("Pi's permission mode fails closed under any ceiling below full", () => {
  expect(piPermissionMode({})).toBe("full")
  expect(piPermissionMode({ permissionMode: "ask" })).toBe("ask")
  expect(piPermissionMode({ permissionMode: "unknown" })).toBe("full")
  expect(piPermissionMode({ permissionMode: "unknown", permissionCeiling: "auto" })).toBe("ask")
  expect(piPermissionMode({ permissionMode: "full", permissionCeiling: "ask" })).toBe("ask")
  expect(piPermissionMode({ permissionCeiling: "full" })).toBe("full")
})
