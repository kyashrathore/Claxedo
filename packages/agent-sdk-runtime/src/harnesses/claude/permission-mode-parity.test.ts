import { describe, expect, test } from "bun:test"
import { HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import {
  CLAUDE_SDK_PERMISSION_MODES,
  CLAUDE_SDK_PERMISSION_MODE_IS_A_REAL_UNION,
  CLAUDE_SDK_PERMISSION_MODE_PARITY,
} from "./permission-mode-parity"

/**
 * The real enforcement lives in `permission-mode-parity.ts`, as type-level
 * assertions, because THIS FILE IS NOT TYPECHECKED — the package tsconfig
 * excludes `src/**\/*.test.ts`. These runtime checks only pin the documented mode
 * set so an upstream rename shows up in the diff.
 */
describe("Claude SDK PermissionMode parity", () => {
  test("the parity assertions are present and hold", () => {
    expect(CLAUDE_SDK_PERMISSION_MODE_PARITY).toBe(true)
    expect(CLAUDE_SDK_PERMISSION_MODE_IS_A_REAL_UNION).toBe(true)
  })

  test("documents the SDK's current mode set", () => {
    expect([...CLAUDE_SDK_PERMISSION_MODES]).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ])
  })

  test("the harness table offers exactly the SDK's modes", () => {
    expect(HARNESS_TABLE.claude.permissionModes.modes.map((mode) => mode.id).sort()).toEqual([...CLAUDE_SDK_PERMISSION_MODES].sort())
  })

  test("mode ids are unique", () => {
    expect(new Set(CLAUDE_SDK_PERMISSION_MODES).size).toBe(CLAUDE_SDK_PERMISSION_MODES.length)
  })
})
