import { describe, expect, test } from "vitest"
import { combineRolePrecedence } from "../../../../convex/model"

describe("project/workspace role precedence", () => {
  test.each([
    ["owner short-circuits", { owner: true, directWorkspace: "viewer" as const }, "owner"],
    ["org member maps to viewer", { directOrg: "viewer" as const }, "viewer"],
    ["maxes workspace viewer with org admin", { directWorkspace: "viewer" as const, directOrg: "admin" as const }, "admin"],
    ["maxes direct project editor with share viewer", { directProject: "editor" as const, share: "viewer" as const }, "editor"],
    ["returns undefined for no grants", {}, undefined],
  ])("%s", (_name, input, expected) => {
    expect(combineRolePrecedence(input)).toBe(expected)
  })
})
