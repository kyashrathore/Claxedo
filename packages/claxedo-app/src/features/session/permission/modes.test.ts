import { describe, expect, test } from "bun:test"
import { HARNESS_IDS, type HarnessId } from "@/platform/identity/session-ref"
import type { AgentPermissionModeState } from "@claxedo/agent-sdk-runtime/adapter-contract"
import { PERMISSION_MECHANISMS } from "./mechanisms"
import {
  CLAXEDO_ALLOW_SAFE_ID,
  CLAXEDO_ASK_ALWAYS_ID,
  DANGER_GATED_PERMISSIONS,
  IN_PROJECT_WRITE_PERMISSIONS,
  SAFE_READ_PERMISSIONS,
  claxedoPermissionModes,
  defaultPermissionSelection,
  findPermissionModeOption,
  harnessPermissionModes,
  permissionModeOptions,
  type HarnessModeReport,
} from "./modes"

const report = (input: Partial<HarnessModeReport> = {}): HarnessModeReport => ({
  modes: [],
  appliesFrom: "next-turn",
  ...input,
})

const THREE_MODES: HarnessModeReport = report({
  modes: [
    { id: "default", name: "Default", description: "Prompts for dangerous operations", level: "ask" },
    { id: "acceptEdits", name: "Accept edits", description: "Auto-accept file edits" },
    { id: "auto", name: "Auto-review", description: "A classifier decides", level: "auto" },
  ],
})

describe("harness modes are shown in the harness's own words", () => {
  // The core rule of this module. Every user-visible string here came off the
  // wire; nothing is derived from HarnessId. The previous design held a per-SDK
  // table in the app, and that table was wrong about three harnesses at once
  // because nothing forced it to agree with the installed packages.
  test("id, name and description pass through untouched", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk", report: THREE_MODES })
    expect(modes.map((mode) => mode.id)).toEqual(["default", "acceptEdits", "auto"])
    expect(modes.map((mode) => mode.name)).toEqual(["Default", "Accept edits", "Auto-review"])
    expect(modes[2]!.description).toBe("A classifier decides")
    for (const mode of modes) expect(mode.origin).toBe("harness")
  })

  test("Claxedo contributes exactly one option, and it is called Auto", () => {
    for (const harness of HARNESS_IDS) {
      // With a reporting harness there is a list below to switch to, so Auto is
      // the only thing Claxedo adds.
      const options = claxedoPermissionModes({ harness, report: THREE_MODES })
      expect(options.map((option) => option.name), harness).toEqual(["Auto"])
    }
  })

  test("a harness reporting nothing also gets an off switch", () => {
    for (const harness of HARNESS_IDS) {
      // Nothing to switch TO otherwise — Auto alone would be a one-item picker
      // with no way back.
      const options = claxedoPermissionModes({ harness })
      expect(options.map((option) => option.name), harness).toEqual(["Auto", "Ask for everything"])
    }
  })

  test("Auto resolves to whoever actually enforces it", () => {
    // opencode writes its own ruleset.
    const [opencodeAuto] = claxedoPermissionModes({ harness: "opencode", report: THREE_MODES })
    expect(opencodeAuto!.delivery.kind).toBe("opencode-session-ruleset")

    // A harness reporting an auto rung has that rung forwarded verbatim, so the
    // HARNESS enforces the result rather than Claxedo answering prompts.
    const [claudeAuto] = claxedoPermissionModes({ harness: "claude-sdk", report: THREE_MODES })
    expect(claudeAuto!.delivery).toMatchObject({ kind: "harness-permission-mode", modeId: "auto" })
    // Auto is collapsed by default, so this line is the only thing most people
    // read about what their session runs under. It has to name the CONCRETE
    // target — the harness, the mode id actually written, and the harness's own
    // sentence — not a paraphrase that could drift from behaviour.
    expect(claudeAuto!.description).toContain("Claude")
    expect(claudeAuto!.description).toContain("auto")
    expect(claudeAuto!.description).toContain("A classifier decides")
    expect(claudeAuto!.caveat).toBeUndefined()

    // Only with neither does Claxedo answer locally — and only there does the
    // caveat saying so appear.
    const [localAuto] = claxedoPermissionModes({ harness: "pi" })
    expect(localAuto!.delivery.kind).toBe("claxedo-auto-answer")
    expect(localAuto!.caveat).toMatch(/harness enforces nothing/i)
  })

  test("the local-answering caveat never appears on a harness that enforces", () => {
    // The bug this replaces: every non-opencode harness fell to local answering,
    // so seven harnesses claimed nothing was enforced while their own auto rung
    // sat unused in the report.
    for (const harness of HARNESS_IDS) {
      const [auto] = claxedoPermissionModes({ harness, report: THREE_MODES })
      expect(auto!.caveat ?? "", harness).not.toMatch(/harness enforces nothing/i)
    }
  })

  // THREE distinct empty states, and collapsing any two is how a permanent gap
  // comes to look like a spinner — which is exactly what shipped before.
  test("not fetched, unsupported, and reported-nothing read differently", () => {
    const loading = harnessPermissionModes({ harness: "claude-acp" })
    expect(loading.modes).toEqual([])
    expect(loading.unavailable).toMatch(/loading/i)

    const unsupported = harnessPermissionModes({
      harness: "pi",
      report: report({ unsupported: "Pi has no permission modes of its own" }),
    })
    expect(unsupported.unavailable).toBe("Pi has no permission modes of its own")

    const empty = harnessPermissionModes({ harness: "claude-acp", report: report() })
    expect(empty.unavailable).toMatch(/has not reported/i)
    expect(empty.unavailable).not.toMatch(/loading/i)
  })

  // Cursor's options are read by Agent.create, so a change cannot reach the
  // session on screen. Every row has to say so or the picker is wrong by a whole
  // session lifetime.
  test("a next-session harness says so on every row", () => {
    const { modes } = harnessPermissionModes({
      harness: "cursor-sdk",
      report: report({ modes: [{ id: "auto-review", name: "Auto-review" }], appliesFrom: "next-session" }),
    })
    expect(modes[0]!.caveat).toMatch(/next .* agent/i)
    const delivery = modes[0]!.delivery
    if (delivery.kind !== "harness-permission-mode") throw new Error("expected a harness delivery")
    expect(delivery.appliesFrom).toBe("next-session")
  })

  /*
   * A draft has no session, so there is nothing for a next-session change to be
   * excluded FROM. The caveat read "applies to the next agent, not this session"
   * on a composer where no session existed — describing a distinction that had
   * no second term. The first message creates the session and runs under exactly
   * the chosen mode, so on a draft the choice is simply in force.
   */
  test("a next-session harness stays silent on a draft", () => {
    const cursor = report({
      modes: [{ id: "auto-review", name: "Auto-review", level: "auto" }],
      appliesFrom: "next-session",
    })
    const draft = permissionModeOptions({ harness: "cursor-sdk", report: cursor, hasSession: false })
    expect(draft.claxedo[0]!.caveat).toBeUndefined()
    for (const mode of draft.harness.modes) expect(mode.caveat, mode.id).toBeUndefined()

    const live = permissionModeOptions({ harness: "cursor-sdk", report: cursor, hasSession: true })
    expect(live.claxedo[0]!.caveat).toMatch(/next .* agent/i)
    for (const mode of live.harness.modes) expect(mode.caveat, mode.id).toMatch(/next .* agent/i)
  })

  /*
   * Auto's description quotes the mode id so a collapsed row can be checked
   * against the harness's own docs, and that now holds on a DRAFT too.
   *
   * It did not used to. An ACP agent advertises nothing until `session/new`, so
   * Claxedo used to fill a draft with intent rungs of its own naming and this
   * test asserted the opposite — that `(auto)` was suppressed, because printing
   * it would lend a placeholder of ours the authority of a harness id. Drafts
   * now carry the agent's recorded ids (`ACP_KNOWN_MODES`), so the id is real
   * and hiding it would withhold the one string that makes the row checkable.
   *
   * So the invariant is that a draft and a live session describe Auto the SAME
   * way. This is the direct regression test for the removed `hasSession` branch:
   * a draft that described its target differently was a draft describing a
   * different thing, which is what made the list appear to change on the first
   * message.
   *
   * Uses codex-acp's real auto rung, verbatim from the live binary.
   */
  test("a draft and a live session describe Auto identically", () => {
    const codexAcp = report({
      modes: [{ id: "agent", name: "Agent", description: "Read and edit files, and run commands.", level: "auto" }],
    })
    const draft = permissionModeOptions({ harness: "codex-acp", report: codexAcp, hasSession: false })
    const live = permissionModeOptions({ harness: "codex-acp", report: codexAcp, hasSession: true })
    expect(draft.claxedo[0]!.description).toBe(live.claxedo[0]!.description)
    expect(draft.claxedo[0]!.description).toContain("Read and edit files")
  })

  /*
   * The id is dropped only when it would repeat the name. claude-agent-acp's
   * auto rung is literally `{ id: "auto", name: "Auto" }`, and "Auto (auto)"
   * is noise rather than information.
   */
  test("an id identical to the name is not repeated", () => {
    const claudeAcp = report({
      modes: [
        { id: "auto", name: "Auto", description: "Use a model classifier to approve/deny prompts", level: "auto" },
      ],
    })
    const draft = permissionModeOptions({ harness: "claude-acp", report: claudeAcp, hasSession: false })
    expect(draft.claxedo[0]!.description).not.toContain("(auto)")
    expect(draft.claxedo[0]!.description).toContain("Auto")
  })

  test("a real harness id stays quoted, because it names the policy", () => {
    // codex's id IS its sandbox policy, which is the whole reason for quoting.
    const codex = report({
      modes: [{ id: "workspace-write", name: "Workspace write", level: "auto" }],
    })
    const draft = permissionModeOptions({ harness: "codex-app-server", report: codex, hasSession: false })
    expect(draft.claxedo[0]!.description).toContain("(workspace-write)")
  })

  test("a next-turn harness adds no session caveat", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk", report: THREE_MODES })
    for (const mode of modes) expect(mode.caveat, mode.id).toBeUndefined()
  })
})

describe("Auto sits above the harness's own modes", () => {
  // These are no longer mutually exclusive, and the reason the old rule existed
  // still holds: two controls over one behaviour with no way to tell which wins
  // is unreadable. What resolves it is that Auto is not a competing control — it
  // forwards the harness's own auto rung, so picking Auto and picking that rung
  // from the list below are the same write.
  test("a harness with modes contributes them, with Auto above", () => {
    const options = permissionModeOptions({ harness: "claude-sdk", report: THREE_MODES })
    expect(options.claxedo.map((option) => option.name)).toEqual(["Auto"])
    expect(options.harness.modes).toHaveLength(3)
  })

  test("a harness with no modes still gets Auto, plus an off switch", () => {
    const options = permissionModeOptions({ harness: "opencode", report: report() })
    expect(options.harness.modes).toEqual([])
    expect(options.claxedo.map((option) => option.id)).toEqual([CLAXEDO_ALLOW_SAFE_ID, CLAXEDO_ASK_ALWAYS_ID])
  })

  test("every harness id resolves without throwing, and empty always says why", () => {
    for (const harness of HARNESS_IDS) {
      const result = harnessPermissionModes({ harness, report: report() })
      expect(Array.isArray(result.modes)).toBe(true)
      if (result.modes.length === 0) expect(result.unavailable, harness).toBeTruthy()
    }
    expect(Object.keys(PERMISSION_MECHANISMS).sort()).toEqual([...HARNESS_IDS].sort())
  })
})

describe("Claxedo's own options, where nothing else enforces", () => {
  // opencode has rules rather than modes, so Claxedo writes them. The ordering is
  // load-bearing: evaluate() takes the LAST matching rule.
  test("allow-safe puts the catch-all first and grants after it", () => {
    const option = claxedoPermissionModes({ harness: "opencode" }).find((row) => row.id === CLAXEDO_ALLOW_SAFE_ID)!
    const delivery = option.delivery
    if (delivery.kind !== "opencode-session-ruleset") throw new Error("expected a ruleset")
    expect(delivery.ruleset[0]).toEqual({ permission: "*", pattern: "*", action: "ask" })
    for (const key of [...SAFE_READ_PERMISSIONS, ...IN_PROJECT_WRITE_PERMISSIONS]) {
      expect(delivery.ruleset.filter((rule) => rule.permission === key).at(-1)?.action, key).toBe("allow")
    }
    for (const key of DANGER_GATED_PERMISSIONS) {
      expect(delivery.ruleset.filter((rule) => rule.permission === key).at(-1)?.action, key).toBe("ask")
    }
  })

  // Nothing deletes rules in the engine, so the way back has to be WRITTEN. If
  // this sent nothing, the engine would stay permissive while the picker read
  // "ask for everything" — a security regression invisible from the UI.
  test("ask-always genuinely withdraws rather than sending nothing", () => {
    const option = claxedoPermissionModes({ harness: "opencode" }).find((row) => row.id === CLAXEDO_ASK_ALWAYS_ID)!
    const delivery = option.delivery
    if (delivery.kind !== "opencode-session-ruleset") throw new Error("expected a ruleset")
    expect(delivery.ruleset.every((rule) => rule.action === "ask")).toBe(true)
    for (const key of [...SAFE_READ_PERMISSIONS, ...IN_PROJECT_WRITE_PERMISSIONS]) {
      expect(delivery.ruleset.some((rule) => rule.permission === key), key).toBe(true)
    }
  })

  // Everywhere else Claxedo answers in-process: nothing is enforced and the
  // grants die with the app. The row must admit that.
  test("off opencode, the permissive option says Claxedo is the one answering", () => {
    for (const harness of HARNESS_IDS.filter((id) => id !== "opencode")) {
      const option = claxedoPermissionModes({ harness }).find((row) => row.id === CLAXEDO_ALLOW_SAFE_ID)!
      expect(option.delivery.kind, harness).toBe("claxedo-auto-answer")
      expect(option.caveat, harness).toMatch(/Claxedo answers/i)
    }
  })
})

describe("choosing a default", () => {
  // The harness's own current mode wins. On a resumed session that is the mode
  // genuinely in force, which no local copy could know.
  test("what the harness says is current beats the auto rung", () => {
    const selection = defaultPermissionSelection({
      harness: "claude-sdk",
      report: { ...THREE_MODES, currentModeId: "default" },
    })
    expect(selection).toEqual({ kind: "harness", modeId: "default" })
  })

  test("with no current mode reported, Auto is chosen", () => {
    // The auto rung is still what runs; it is NAMED Auto rather than by the
    // harness's word for it, because the picker shows Auto as a collapsed label
    // over exactly that mode. Selecting both would read as two states.
    expect(defaultPermissionSelection({ harness: "claude-sdk", report: THREE_MODES })).toEqual({
      kind: "claxedo",
      modeId: CLAXEDO_ALLOW_SAFE_ID,
    })
  })

  // Never blank while a real mode list exists: a picker showing nothing next to
  // a running harness reads as broken.
  test("with no rung at all, the first mode is chosen rather than none", () => {
    const selection = defaultPermissionSelection({
      harness: "codex-acp",
      report: report({ modes: [{ id: "only", name: "Only mode" }] }),
    })
    expect(selection).toEqual({ kind: "harness", modeId: "only" })
  })

  test("with no harness modes, Claxedo's permissive option is the default", () => {
    expect(defaultPermissionSelection({ harness: "opencode", report: report() })).toEqual({
      kind: "claxedo",
      modeId: CLAXEDO_ALLOW_SAFE_ID,
    })
  })
})

describe("resolving a stored selection", () => {
  // `kind` is not decoration. The same id can exist in both groups, and resolving
  // one against the other's list would silently return the wrong option.
  test("a claxedo id is never resolved against the harness list", () => {
    const collide = report({ modes: [{ id: CLAXEDO_ALLOW_SAFE_ID, name: "A harness mode that shares the id" }] })
    const asHarness = findPermissionModeOption({
      selection: { kind: "harness", modeId: CLAXEDO_ALLOW_SAFE_ID },
      harness: "claude-acp",
      report: collide,
    })
    expect(asHarness?.name).toBe("A harness mode that shares the id")
    expect(asHarness?.origin).toBe("harness")

    const asClaxedo = findPermissionModeOption({
      selection: { kind: "claxedo", modeId: CLAXEDO_ALLOW_SAFE_ID },
      harness: "claude-acp",
      report: collide,
    })
    expect(asClaxedo?.origin).toBe("claxedo")
  })

  // A mode the harness stopped advertising must read as unresolved, not wear
  // another mode's label while a different id is stored.
  test("a vanished harness mode resolves to undefined", () => {
    expect(
      findPermissionModeOption({
        selection: { kind: "harness", modeId: "gone" },
        harness: "claude-acp",
        report: THREE_MODES,
      }),
    ).toBeUndefined()
  })
})

/**
 * The runtime produces this shape and the app re-declares it as a wire type, so
 * the two can drift silently — the app would keep compiling and quietly stop
 * understanding half the payload.
 *
 * The assertion is the ASSIGNMENT, checked at compile time by `tsgo -b`, not the
 * `expect` below: a renamed or retyped field on the runtime's own
 * `AgentPermissionModeState` fails to build here. The runtime type is imported
 * type-only, so this adds no runtime dependency on that package.
 */
describe("the wire shape matches the runtime's own declaration", () => {
  test("the runtime's state is assignable to the app's report, and back", () => {
    const fromRuntime: AgentPermissionModeState = {
      modes: [{ id: "a", name: "A", description: "d", level: "auto" }],
      currentModeId: "a",
      appliesFrom: "next-turn",
    }
    const asReport: HarnessModeReport = fromRuntime
    const backAgain: AgentPermissionModeState = { ...asReport, modes: [...asReport.modes] }
    expect(backAgain.currentModeId).toBe("a")
    expect(asReport.appliesFrom).toBe("next-turn")
  })
})
