import { describe, expect, test } from "bun:test"
import { HARNESS_IDS, type HarnessId } from "@/platform/identity/session-ref"
import { PERMISSION_MECHANISMS } from "./mechanisms"
import {
  claxedoAutoMode,
  CLAXEDO_AUTO_ID,
  DANGER_GATED_PERMISSIONS,
  DEFAULT_PERMISSION_SELECTION,
  findPermissionModeOption,
  harnessPermissionModes,
  IN_PROJECT_WRITE_PERMISSIONS,
  permissionModeOptions,
  SAFE_READ_PERMISSIONS,
  type AdvertisedPermissionMode,
} from "./modes"

const ACP_HARNESSES: HarnessId[] = ["claude-acp", "codex-acp", "cursor-acp"]

describe("Claxedo's one built-in mode", () => {
  test("Auto is the default selection", () => {
    expect(DEFAULT_PERMISSION_SELECTION).toEqual({ kind: "claxedo-auto" })
  })

  test("Auto is offered on EVERY harness — it is the one mode Claxedo implements itself", () => {
    for (const harness of HARNESS_IDS) {
      const options = permissionModeOptions({ harness, advertisedModes: [] })
      expect(options.claxedo).toEqual([claxedoAutoMode(harness)])
      expect(options.claxedo[0]!.id).toBe(CLAXEDO_AUTO_ID)
      expect(options.claxedo[0]!.name).toBe("Auto")
    }
  })

  // Auto's INTENT is identical everywhere; its DELIVERY is not. Delegating to a
  // harness that natively implements the intent is better than answering prompts
  // after the fact — it is enforced, and Claude's own classifier beats a fixed
  // allowlist. This table is the contract.
  test("Auto delegates to the native mechanism where one exists", () => {
    const opencode = claxedoAutoMode("opencode").delivery
    if (opencode.kind !== "opencode-config-rules") throw new Error("expected config rules")
    expect(opencode.rules["*"]).toBe("ask")
    expect(opencode.rules.read).toBe("allow")
    expect(opencode.rules.edit).toBe("allow")
    expect(opencode.rules.bash).toBe("ask")

    // Claude's own classifier, not our allowlist.
    expect(claxedoAutoMode("claude-sdk").delivery).toEqual({
      kind: "claude-sdk-permission-mode",
      permissionMode: "auto",
    })

    expect(claxedoAutoMode("codex-app-server").delivery).toEqual({
      kind: "codex-approval-policy",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })
  })

  test("Auto answers locally only where the harness offers nothing", () => {
    // ACP included on purpose: its mode ids are open strings, so choosing one by
    // guessing is the mistake this design removed.
    for (const harness of [...ACP_HARNESSES, "cursor-sdk", "pi"] as HarnessId[]) {
      const option = claxedoAutoMode(harness)
      const delivery = option.delivery
      if (delivery.kind !== "claxedo-auto-answer") throw new Error(`expected local answering for ${harness}`)
      for (const key of [...SAFE_READ_PERMISSIONS, ...IN_PROJECT_WRITE_PERMISSIONS]) {
        expect(delivery.autoAnswer).toContain(key)
      }
      for (const key of DANGER_GATED_PERMISSIONS) {
        expect(delivery.autoAnswer).not.toContain(key)
      }
      // Answer with `always` so the harness PERSISTS the grant: a safe permission
      // is answered once, not re-answered forever (which is what `once` would do,
      // leaving the permission ungranted the moment Claxedo is not there).
      expect(delivery.respondWith).toBe("always")
      // Must admit that Claxedo, not the harness, decided.
      expect(option.caveat).toContain("Claxedo")
    }
  })

  test("every harness where Auto is not enforced by the harness says so", () => {
    for (const harness of HARNESS_IDS) {
      const option = claxedoAutoMode(harness)
      if (option.delivery.kind === "claxedo-auto-answer") expect(option.caveat).toBeTruthy()
    }
  })

  test("Auto on Claude flags the model-support condition", () => {
    expect(claxedoAutoMode("claude-sdk").caveat).toContain("supports auto mode")
  })
})

describe("harness-supplied modes", () => {
  // The completeness guarantee: every canonical harness id must be handled, so a
  // newly added harness cannot silently fall through to an empty picker. The
  // mechanism table is a Record<HarnessId, …>, which makes this a compile error
  // too — this test covers the runtime half.
  test("every canonical harness id resolves without throwing", () => {
    for (const harness of HARNESS_IDS) {
      const result = harnessPermissionModes({ harness, advertisedModes: [] })
      expect(Array.isArray(result.modes)).toBe(true)
      // Empty means we MUST say why. A silent empty list is the failure mode this
      // whole design exists to prevent.
      if (result.modes.length === 0) expect(result.unavailable).toBeTruthy()
      else expect(result.unavailable).toBeUndefined()
    }
    expect(Object.keys(PERMISSION_MECHANISMS).sort()).toEqual([...HARNESS_IDS].sort())
  })

  test("harnesses with no permission surface offer nothing, and say so", () => {
    // Verified against @cursor/sdk 1.0.23: only an agent/plan execution mode.
    const cursor = harnessPermissionModes({ harness: "cursor-sdk" })
    expect(cursor.modes).toEqual([])
    expect(cursor.unavailable).toContain("no permission")

    const pi = harnessPermissionModes({ harness: "pi" })
    expect(pi.modes).toEqual([])
    expect(pi.unavailable).toContain("Claxedo's Auto")

    const opencode = harnessPermissionModes({ harness: "opencode" })
    expect(opencode.modes).toEqual([])
    expect(opencode.unavailable).toContain("config rules")
  })

  test("Claude SDK exposes its real typed union, with the SDK's own descriptions", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk" })
    expect(modes.map((mode) => mode.id)).toEqual([
      "default",
      "acceptEdits",
      "auto",
      "plan",
      "dontAsk",
      "bypassPermissions",
    ])
    // The SDK's own wording for auto mode, not ours.
    expect(modes.find((mode) => mode.id === "auto")?.description).toBe(
      "Use a model classifier to approve/deny permission prompts",
    )
  })

  test("bypassPermissions carries the SDK's required companion flag", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk" })
    const bypass = modes.find((mode) => mode.id === "bypassPermissions")!
    if (bypass.delivery.kind !== "claude-sdk-permission-mode") throw new Error("expected sdk mode")
    // The SDK rejects bypassPermissions unless this is also set.
    expect(bypass.delivery.allowDangerouslySkipPermissions).toBe(true)
    expect(bypass.caveat).toBeTruthy()
  })

  test("modes whose availability is conditional carry a caveat", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-sdk" })
    // supportsAutoMode is per-model, disableAutoMode is a setting, and an org
    // ceiling can force prompts anyway — none of which a mode list reveals.
    expect(modes.find((mode) => mode.id === "auto")?.caveat).toBeTruthy()
  })

  test("Codex SDK exposes approval policies paired with a coherent sandbox", () => {
    const { modes } = harnessPermissionModes({ harness: "codex-app-server" })
    expect(modes.map((mode) => mode.id)).toEqual(["untrusted", "on-request", "read-only", "never"])
    const readOnly = modes.find((mode) => mode.id === "read-only")!
    if (readOnly.delivery.kind !== "codex-approval-policy") throw new Error("expected codex policy")
    expect(readOnly.delivery.sandbox).toBe("read-only")
    // Honest about not being a plan mode.
    expect(readOnly.caveat).toContain("no plan mode")
  })
})

describe("ACP harnesses report their own modes", () => {
  const advertised: AdvertisedPermissionMode[] = [
    { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
    { id: "acceptEdits", name: "Accept edits" },
  ]

  test("options use the agent's own name and description verbatim", () => {
    for (const harness of ACP_HARNESSES) {
      const { modes } = harnessPermissionModes({ harness, advertisedModes: advertised })
      expect(modes.map((mode) => ({ id: mode.id, name: mode.name, description: mode.description }))).toEqual([
        { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
        { id: "acceptEdits", name: "Accept edits", description: undefined },
      ])
      expect(modes.every((mode) => mode.origin === "harness")).toBe(true)
    }
  })

  test("each option delivers via set_session_mode with the advertised id", () => {
    const { modes } = harnessPermissionModes({ harness: "claude-acp", advertisedModes: advertised })
    for (const mode of modes) {
      expect(mode.delivery).toEqual({ kind: "acp-set-session-mode", modeId: mode.id })
    }
  })

  // Not-yet-reported and genuinely-none are different situations and must read
  // differently: one resolves later, the other never will.
  test("undefined advertised modes reads as waiting, empty reads as none reported", () => {
    const waiting = harnessPermissionModes({ harness: "claude-acp" })
    expect(waiting.modes).toEqual([])
    expect(waiting.unavailable).toContain("Waiting")

    const none = harnessPermissionModes({ harness: "claude-acp", advertisedModes: [] })
    expect(none.modes).toEqual([])
    expect(none.unavailable).toContain("no modes")
    expect(none.unavailable).not.toContain("Waiting")
  })

  test("nothing is invented for an id we do not recognise", () => {
    const { modes } = harnessPermissionModes({
      harness: "cursor-acp",
      advertisedModes: [{ id: "some-cursor-only-mode", name: "Cursor's own thing" }],
    })
    expect(modes).toEqual([
      {
        id: "some-cursor-only-mode",
        name: "Cursor's own thing",
        origin: "harness",
        delivery: { kind: "acp-set-session-mode", modeId: "some-cursor-only-mode" },
      },
    ])
  })
})

describe("findPermissionModeOption", () => {
  test("resolves Claxedo Auto on any harness", () => {
    for (const harness of HARNESS_IDS) {
      expect(findPermissionModeOption({ selection: { kind: "claxedo-auto" }, harness })).toEqual(
        claxedoAutoMode(harness),
      )
    }
  })

  test("resolves a harness mode by id", () => {
    const option = findPermissionModeOption({
      selection: { kind: "harness", modeId: "plan" },
      harness: "claude-sdk",
    })
    expect(option?.name).toBe("Plan")
  })

  // A selection persisted against one harness must not silently apply to another.
  test("returns undefined for a selection the current harness does not offer", () => {
    expect(
      findPermissionModeOption({ selection: { kind: "harness", modeId: "plan" }, harness: "cursor-sdk" }),
    ).toBeUndefined()
    expect(
      findPermissionModeOption({
        selection: { kind: "harness", modeId: "bypassPermissions" },
        harness: "claude-acp",
        advertisedModes: [{ id: "default", name: "Default" }],
      }),
    ).toBeUndefined()
  })
})
