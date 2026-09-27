import type { AgentPermissionMode } from "@claxedo/agent-runtime-contract"
import { describe, expect, test } from "bun:test"
import {
  comparePermissionLevels,
  isAutoLevel,
  narrowerPermissionLevel,
  permissionCeilingAdmits,
  permissionModeLevel,
  widestPermissionModeUnder,
} from "./permission-ceiling"
const leveled = (id: string, level?: AgentPermissionMode["level"]): AgentPermissionMode => ({ id, name: id, description: id, ...(level ? { level } : {}) })

/** Each harness's mode ladder as its transport declares it: one `ask`, one `auto`, one `full` rung, plus unleveled modes. */
const CLAUDE_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  leveled("default", "ask"), leveled("acceptEdits"), leveled("auto", "auto"), leveled("plan"), leveled("dontAsk"), leveled("bypassPermissions", "full"),
]
const CURSOR_PERMISSION_MODES: readonly AgentPermissionMode[] = [leveled("review", "ask"), leveled("auto-review", "auto"), leveled("unsandboxed", "full")]
const CODEX_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  leveled("read-only", "ask"), leveled("workspace-write", "auto"), leveled("untrusted"), leveled("full-access", "full"),
]

const mode = (table: readonly AgentPermissionMode[], id: string) => table.find((entry) => entry.id === id)

describe("permission ceiling", () => {
  test("orders ask below auto below full", () => {
    expect(comparePermissionLevels("ask", "auto")).toBe(-1)
    expect(comparePermissionLevels("auto", "full")).toBe(-1)
    expect(comparePermissionLevels("full", "ask")).toBe(1)
    expect(comparePermissionLevels("auto", "auto")).toBe(0)
    expect(narrowerPermissionLevel("full", "ask")).toBe("ask")
    expect(isAutoLevel("auto")).toBe(true)
    expect(isAutoLevel("plan")).toBe(false)
  })

  test("a child may equal or narrow its ceiling, never widen it, across harnesses", () => {
    const claudeDefault = permissionModeLevel(mode(CLAUDE_PERMISSION_MODES, "default"))
    const codexWorkspaceWrite = permissionModeLevel(mode(CODEX_PERMISSION_MODES, "workspace-write"))
    const cursorUnsandboxed = permissionModeLevel(mode(CURSOR_PERMISSION_MODES, "unsandboxed"))
    expect(permissionCeilingAdmits(claudeDefault, codexWorkspaceWrite)).toBe(false)
    expect(permissionCeilingAdmits(codexWorkspaceWrite, claudeDefault)).toBe(true)
    expect(permissionCeilingAdmits(codexWorkspaceWrite, cursorUnsandboxed)).toBe(false)
    expect(permissionCeilingAdmits(cursorUnsandboxed, codexWorkspaceWrite)).toBe(true)
  })

  test("unleveled modes rank at the floor in both roles", () => {
    expect(permissionModeLevel(mode(CLAUDE_PERMISSION_MODES, "plan"))).toBe("ask")
    expect(permissionModeLevel(mode(CLAUDE_PERMISSION_MODES, "dontAsk"))).toBe("ask")
    expect(permissionModeLevel(mode(CODEX_PERMISSION_MODES, "untrusted"))).toBe("ask")
    expect(permissionModeLevel(undefined)).toBe("ask")
    expect(permissionCeilingAdmits("ask", permissionModeLevel(mode(CLAUDE_PERMISSION_MODES, "plan")))).toBe(true)
    expect(permissionCeilingAdmits(permissionModeLevel(mode(CLAUDE_PERMISSION_MODES, "plan")), "auto")).toBe(false)
  })

  test("picks the widest leveled mode under a ceiling for a child that named none", () => {
    expect(widestPermissionModeUnder(CODEX_PERMISSION_MODES, "ask")?.id).toBe("read-only")
    expect(widestPermissionModeUnder(CODEX_PERMISSION_MODES, "auto")?.id).toBe("workspace-write")
    expect(widestPermissionModeUnder(CLAUDE_PERMISSION_MODES, "full")?.id).toBe("bypassPermissions")
    expect(widestPermissionModeUnder(CURSOR_PERMISSION_MODES, "auto")?.id).toBe("auto-review")
    expect(widestPermissionModeUnder([{ id: "plan", name: "Plan" }], "full")).toBeUndefined()
  })
})
