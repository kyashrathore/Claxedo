import { describe, expect, test } from "bun:test"
import { HARNESS_TABLE, defaultPermissionModeId } from "@claxedo/agent-runtime-contract"
import {
  CLAUDE_DENY_FLOOR,
  CODEX_SETTINGS,
  codexSandboxPolicy,
  codexSettingsFor,
  cursorPermissionOptions,
} from "./permission-modes"

const CODEX_DEFAULT_MODE = defaultPermissionModeId(HARNESS_TABLE.codex.permissionModes)!

describe("Codex encodings", () => {
  // `turn/start` takes a structured policy while `thread/start` takes the slug.
  test("the sandbox slug becomes the structured policy turn/start expects", () => {
    expect(codexSandboxPolicy("read-only", "/w")).toEqual({ type: "readOnly" })
    expect(codexSandboxPolicy("danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" })
    expect(codexSandboxPolicy("workspace-write", "/w")).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/w"],
    })
  })

  test("the default rung is the workspace sandbox, which asks outside it", () => {
    expect(CODEX_SETTINGS[CODEX_DEFAULT_MODE]).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" })
  })

  test("an unset or unknown mode resolves to the default rung, never undefined", () => {
    expect(codexSettingsFor(undefined)).toEqual(CODEX_SETTINGS[CODEX_DEFAULT_MODE])
    expect(codexSettingsFor("nonsense")).toEqual(CODEX_SETTINGS[CODEX_DEFAULT_MODE])
  })

  test("every codex mode has settings, so no row can be chosen without an encoding", () => {
    for (const mode of HARNESS_TABLE.codex.permissionModes.modes) expect(CODEX_SETTINGS[mode.id], mode.id).toBeTruthy()
  })
})

describe("Cursor options", () => {
  test("each mode maps to the LocalAgentOptions fields Agent.create reads", () => {
    expect(cursorPermissionOptions("review")).toEqual({ sandboxOptions: { enabled: true } })
    expect(cursorPermissionOptions("auto-review")).toEqual({ sandboxOptions: { enabled: true }, autoReview: true })
    expect(cursorPermissionOptions("unsandboxed")).toEqual({ sandboxOptions: { enabled: false } })
  })

  // An id this build does not know must leave Cursor's own defaults alone rather
  // than quietly imposing one of ours.
  test("an unknown id contributes nothing", () => {
    expect(cursorPermissionOptions(undefined)).toEqual({})
    expect(cursorPermissionOptions("something-new")).toEqual({})
  })

  test("every cursor mode has an encoding", () => {
    for (const mode of HARNESS_TABLE.cursor.permissionModes.modes) {
      expect(Object.keys(cursorPermissionOptions(mode.id)).length, mode.id).toBeGreaterThan(0)
    }
  })
})

describe("the Claude deny floor", () => {
  // Pattern syntax, because this goes in settings.permissions.deny. Bare tool
  // NAMES are what `disallowedTools` takes — putting these there would match
  // nothing and leave a floor that only looks like it exists.
  test("every entry is a scoped pattern, not a bare tool name", () => {
    expect(CLAUDE_DENY_FLOOR.length).toBeGreaterThan(0)
    for (const rule of CLAUDE_DENY_FLOOR) expect(rule, rule).toMatch(/^[A-Za-z]+\(.+\)$/)
  })
})
