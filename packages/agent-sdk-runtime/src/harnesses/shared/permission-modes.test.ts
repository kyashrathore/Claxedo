import { describe, expect, test } from "bun:test"
import {
  CLAUDE_DENY_FLOOR,
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  CODEX_SETTINGS,
  CURSOR_PERMISSION_MODES,
  DEFAULT_CODEX_MODE,
  PermissionModeSelection,
  codexSandboxPolicy,
  codexSettingsFor,
  cursorPermissionOptions,
} from "./permission-modes"

describe("PermissionModeSelection", () => {
  const selection = () => new PermissionModeSelection(CLAUDE_PERMISSION_MODES, "next-turn")

  test("the auto rung is the default before anyone chooses", () => {
    expect(selection().currentId("ses_1")).toBe("auto")
  })

  test("sessions do not share a selection", () => {
    const modes = selection()
    modes.set("ses_1", "plan")
    expect(modes.currentId("ses_1")).toBe("plan")
    expect(modes.currentId("ses_2")).toBe("auto")
  })

  // Storing an id the harness will later refuse produces a picker that reads as
  // applied while nothing happens — the divergence this channel exists to stop.
  test("an unknown id throws instead of being stored", () => {
    const modes = selection()
    expect(() => modes.set("ses_1", "not-a-mode")).toThrow(/unknown permission mode/i)
    expect(modes.currentId("ses_1")).toBe("auto")
  })

  test("state carries appliesFrom so the picker can say when it lands", () => {
    expect(new PermissionModeSelection(CURSOR_PERMISSION_MODES, "next-session").state("ses_1").appliesFrom).toBe(
      "next-session",
    )
  })
})

describe("the auto rung means full access with the danger tier gated", () => {
  // The rung is a promise about behaviour, so exactly one mode per harness may
  // carry it — otherwise which one becomes the default is list-order trivia.
  test("each harness table has exactly one auto rung", () => {
    for (const [name, modes] of [
      ["claude", CLAUDE_PERMISSION_MODES],
      ["cursor", CURSOR_PERMISSION_MODES],
      ["codex", CODEX_PERMISSION_MODES],
    ] as const) {
      expect(modes.filter((mode) => mode.level === "auto"), name).toHaveLength(1)
    }
  })

  /*
   * The rung is the classifier, not `acceptEdits`.
   *
   * This assertion used to say the opposite, on the reasoning that a classifier
   * "can approve commands as well as edits". That inverted the definition:
   * `acceptEdits` auto-accepts edits and then prompts on every Bash and MCP
   * call, which is neither full access nor automatic, while the classifier
   * approves the safe tiers and escalates genuinely risky ones — which is what
   * the rung promises. It is also the mode Anthropic themselves call "auto".
   */
  test("Claude's rung is the classifier, not acceptEdits", () => {
    expect(CLAUDE_PERMISSION_MODES.find((mode) => mode.level === "auto")?.id).toBe("auto")
    expect(CLAUDE_PERMISSION_MODES.find((mode) => mode.id === "acceptEdits")?.level).toBeUndefined()
  })

  test("Codex's rung is the workspace sandbox, which asks outside it", () => {
    const rung = CODEX_PERMISSION_MODES.find((mode) => mode.level === "auto")!
    expect(rung.id).toBe(DEFAULT_CODEX_MODE)
    expect(CODEX_SETTINGS[rung.id]).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" })
  })
})

describe("Codex encodings", () => {
  // `turn/start` takes a structured policy while `thread/start` takes the slug.
  // The two call sites drifting apart is what pinned the old hardcoded policy.
  test("the sandbox slug becomes the structured policy turn/start expects", () => {
    expect(codexSandboxPolicy("read-only", "/w")).toEqual({ type: "readOnly" })
    expect(codexSandboxPolicy("danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" })
    expect(codexSandboxPolicy("workspace-write", "/w")).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/w"],
    })
  })

  test("an unset or unknown mode resolves to the default rung, never undefined", () => {
    expect(codexSettingsFor(undefined)).toEqual(CODEX_SETTINGS[DEFAULT_CODEX_MODE]!)
    expect(codexSettingsFor("nonsense")).toEqual(CODEX_SETTINGS[DEFAULT_CODEX_MODE]!)
  })

  test("every codex mode has settings, so no row can be chosen without an encoding", () => {
    for (const mode of CODEX_PERMISSION_MODES) expect(CODEX_SETTINGS[mode.id], mode.id).toBeTruthy()
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
    for (const mode of CURSOR_PERMISSION_MODES) {
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
