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
  SANDBOXED_NO_POLICY_REASON,
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

/**
 * Every harness that HAS a policy surface — i.e. all but the sandboxed ones.
 *
 * Derived from the mechanism table rather than hardcoded, so adding another
 * sandboxed harness cannot silently leave these loops asserting that it offers
 * options it does not.
 */
const POLICY_HARNESS_IDS = HARNESS_IDS.filter(
  (id) => PERMISSION_MECHANISMS[id].kind !== "sandboxed-no-policy",
)

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

  test("Claxedo contributes nothing to a harness that reports its own modes", () => {
    for (const harness of POLICY_HARNESS_IDS) {
      // The harness enforces; its list IS the picker. A Claxedo row above it
      // could only be a label over one of those same rows — on Claude, over a
      // row already named "Auto" — so the menu would open on a paraphrase of
      // something it was hiding.
      expect(claxedoPermissionModes({ harness, report: THREE_MODES }), harness).toEqual([])
    }
  })

  test("a harness reporting nothing also gets an off switch", () => {
    for (const harness of POLICY_HARNESS_IDS) {
      // Nothing to switch TO otherwise — Auto alone would be a one-item picker
      // with no way back.
      const options = claxedoPermissionModes({ harness })
      expect(options.map((option) => option.name), harness).toEqual(["Auto", "Ask for everything"])
    }
  })

  /*
   * pi is the exception to both tests above, and deliberately so.
   *
   * Its tools cannot reach anything real — `harnesses/pi/index.ts:176` defaults
   * the session env to just-bash over an InMemoryFs — so there is no policy for
   * an option to express. Offering "Auto" there previously meant flipping a
   * browser-local boolean that gated a permission request pi only emits when the
   * prompt literally starts with `permission:`; every other prompt executed
   * unchecked. The control described a policy that did not exist.
   */
  test("a sandboxed harness gets no options at all, and says why", () => {
    expect(claxedoPermissionModes({ harness: "pi" })).toEqual([])
    expect(claxedoPermissionModes({ harness: "pi", report: THREE_MODES })).toEqual([])
    expect(harnessPermissionModes({ harness: "pi", report: THREE_MODES }).modes).toEqual([])
    expect(harnessPermissionModes({ harness: "pi" }).unavailable).toBe(SANDBOXED_NO_POLICY_REASON)
    // Names both facts, so an empty menu never reads as broken or still loading.
    expect(SANDBOXED_NO_POLICY_REASON).toMatch(/just-bash/i)
    expect(SANDBOXED_NO_POLICY_REASON).toMatch(/cloud/i)
    // Never the loading or the not-reported copy: pi is not slow and will not
    // report later.
    expect(SANDBOXED_NO_POLICY_REASON).not.toMatch(/loading|has not reported/i)
  })

  test("Auto resolves to whoever actually enforces it", () => {
    // opencode writes its own ruleset. It reports no modes of its own, which is
    // why Claxedo names anything here at all.
    const [opencodeAuto] = claxedoPermissionModes({ harness: "opencode" })
    expect(opencodeAuto!.delivery.kind).toBe("opencode-session-ruleset")
    expect(opencodeAuto!.caveat ?? "").not.toMatch(/harness enforces nothing/i)

    // Everywhere else Claxedo answers locally — and the caveat says so, which is
    // only honest because this rung is now unreachable on a harness that reports
    // modes of its own. `cursor-sdk` stands in: not opencode, reporting nothing.
    const [localAuto] = claxedoPermissionModes({ harness: "cursor-sdk" })
    expect(localAuto!.delivery.kind).toBe("claxedo-auto-answer")
    expect(localAuto!.caveat).toMatch(/harness enforces nothing/i)
  })

  test("a reported auto rung is offered as the harness's own row, not relabelled", () => {
    // The regression this pins: Claxedo used to hoist this rung into a row of
    // its own called "Auto", so the same write appeared twice under two names.
    const { modes } = harnessPermissionModes({ harness: "claude-sdk", report: THREE_MODES })
    const auto = modes.find((mode) => mode.id === "auto")!
    expect(auto.name).toBe("Auto-review")
    expect(auto.origin).toBe("harness")
    expect(auto.delivery).toMatchObject({ kind: "harness-permission-mode", modeId: "auto" })
    // Exactly one row applies that mode. Two would be the duplicate this removes.
    const applies = modes.filter((mode) => JSON.stringify(mode.delivery).includes('"modeId":"auto"'))
    expect(applies).toHaveLength(1)
  })

  // THREE distinct empty states, and collapsing any two is how a permanent gap
  // comes to look like a spinner — which is exactly what shipped before.
  test("not fetched, unsupported, and reported-nothing read differently", () => {
    const loading = harnessPermissionModes({ harness: "claude-acp" })
    expect(loading.modes).toEqual([])
    expect(loading.unavailable).toMatch(/loading/i)

    const unsupported = harnessPermissionModes({
      harness: "cursor-sdk",
      report: report({ unsupported: "Cursor reports no modes over this transport" }),
    })
    expect(unsupported.unavailable).toBe("Cursor reports no modes over this transport")

    const empty = harnessPermissionModes({ harness: "claude-acp", report: report() })
    expect(empty.unavailable).toMatch(/has not reported/i)
    expect(empty.unavailable).not.toMatch(/loading/i)
  })

  // A 200 carrying something that is not a mode report has to degrade to a
  // fourth empty state, not throw. This runs inside the composer's render, so a
  // throw here does not break one control — it takes the whole shell into the
  // ErrorBoundary and the user gets a blank "Something went wrong" page. That
  // is not hypothetical: a mis-scoped e2e route served the session row on
  // `/session/:id/permission-mode` and blanked the app on every seeded session.
  test("an unreadable report degrades instead of throwing", () => {
    // Built by parsing a JSON body rather than casting an object literal: that
    // is exactly how the bad value reaches this function in production —
    // `readJson` hands back whatever the response contained, unvalidated.
    const unreadable: HarnessModeReport = JSON.parse(`{"appliesFrom":"next-turn"}`)
    const malformed = harnessPermissionModes({ harness: "claude-sdk", report: unreadable })

    expect(malformed.modes).toEqual([])
    expect(malformed.unavailable).toMatch(/unreadable/i)
  })

  // Same body, the other entry point on the same render path. Guarding only
  // `harnessPermissionModes` left this one still able to blank the app.
  test("an unreadable report falls back to a Claxedo default instead of throwing", () => {
    const unreadable: HarnessModeReport = JSON.parse(`{"appliesFrom":"next-turn"}`)
    const selection = defaultPermissionSelection({ harness: "claude-sdk", report: unreadable })

    expect(selection.kind).toBe("claxedo")
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
    for (const mode of draft.harness.modes) expect(mode.caveat, mode.id).toBeUndefined()

    const live = permissionModeOptions({ harness: "cursor-sdk", report: cursor, hasSession: true })
    for (const mode of live.harness.modes) expect(mode.caveat, mode.id).toMatch(/next .* agent/i)
  })

  /*
   * The next-turn caveat is about a turn that is ALREADY RUNNING, so it cannot be
   * stated before a session exists. On a draft the first message creates the
   * session and runs under exactly this ruleset — telling the user it "applies
   * from your next message" says their choice is ignored for the one turn it
   * actually governs.
   *
   * Same rule as cursor's next-session caveat above, on the opencode path.
   */
  test("opencode's next-turn caveat is suppressed on a draft and present on a session", () => {
    const draft = permissionModeOptions({ harness: "opencode", hasSession: false })
    for (const option of draft.claxedo) expect(option.caveat, option.id).toBeUndefined()

    const live = permissionModeOptions({ harness: "opencode", hasSession: true })
    for (const option of live.claxedo) expect(option.caveat, option.id).toMatch(/next message/i)
    // Both of Claxedo's options carry it, not just Auto — the off switch writes a
    // ruleset too, so it lands at the same moment.
    expect(live.claxedo.length).toBe(2)
  })

  /*
   * A draft and a live session show the SAME list.
   *
   * Claxedo used to hoist the auto rung into a row of its own whose description
   * quoted the harness's id, and that row's copy had a `hasSession` branch — so
   * the list appeared to change on the first message. Nothing is hoisted now, so
   * the invariant is stronger and cheaper to state: the rows are identical, and
   * only the next-session caveat (asserted above) may differ.
   *
   * Uses codex-acp's real auto rung, verbatim from the live binary.
   */
  test("a draft and a live session offer the same rows", () => {
    const codexAcp = report({
      modes: [{ id: "agent", name: "Agent", description: "Read and edit files, and run commands.", level: "auto" }],
    })
    const draft = permissionModeOptions({ harness: "codex-acp", report: codexAcp, hasSession: false })
    const live = permissionModeOptions({ harness: "codex-acp", report: codexAcp, hasSession: true })
    expect(draft.claxedo).toEqual([])
    expect(live.claxedo).toEqual([])
    expect(draft.harness.modes).toEqual(live.harness.modes)
    expect(draft.harness.modes[0]!.description).toContain("Read and edit files")
  })

  test("a next-turn harness adds no session caveat", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk", report: THREE_MODES })
    for (const mode of modes) expect(mode.caveat, mode.id).toBeUndefined()
  })
})

describe("the two groups are mutually exclusive", () => {
  // Two controls over one behaviour with no way to tell which wins is
  // unreadable, and that is what a Claxedo row above the harness's own list was:
  // it forwarded whichever row carried `level: "auto"`, so the same write sat on
  // screen twice under two names.
  test("a harness with modes contributes them and nothing else", () => {
    const options = permissionModeOptions({ harness: "claude-sdk", report: THREE_MODES })
    expect(options.claxedo).toEqual([])
    expect(options.harness.modes).toHaveLength(3)
  })

  test("a harness with no modes gets Auto, plus an off switch", () => {
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
    for (const harness of POLICY_HARNESS_IDS.filter((id) => id !== "opencode")) {
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

  test("with no current mode reported, the harness's own auto rung is chosen", () => {
    // By the HARNESS's id, not Claxedo's. This used to return
    // `claxedo-allow-safe` because a Claxedo "Auto" row stood in front of the
    // list; with that row gone, a claxedo id here would select a row the picker
    // does not render and the trigger would read "Permissions".
    expect(defaultPermissionSelection({ harness: "claude-sdk", report: THREE_MODES })).toEqual({
      kind: "harness",
      modeId: "auto",
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

    // The same id under the CLAXEDO kind resolves to nothing, because a harness
    // that reports modes contributes them all and Claxedo contributes none. The
    // point stands either way: what it must never do is hand back the harness's
    // row for a selection that says claxedo, which would put a harness mode's
    // name on a Claxedo write.
    const asClaxedo = findPermissionModeOption({
      selection: { kind: "claxedo", modeId: CLAXEDO_ALLOW_SAFE_ID },
      harness: "claude-acp",
      report: collide,
    })
    expect(asClaxedo).toBeUndefined()

    // And with no harness list in play, the claxedo id resolves to the Claxedo
    // option — so the branch is doing real work rather than always failing.
    const alone = findPermissionModeOption({
      selection: { kind: "claxedo", modeId: CLAXEDO_ALLOW_SAFE_ID },
      harness: "claude-acp",
      report: report(),
    })
    expect(alone?.origin).toBe("claxedo")
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
