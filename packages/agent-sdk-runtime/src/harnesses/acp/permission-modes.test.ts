import { describe, expect, test } from "bun:test"
import { init, merge, permissionModes, setPermissionMode, type ACPState } from "./session"

const state = (over: Partial<ACPState> = {}): ACPState => ({ ...init(null), ...over })

const conn = (reply: unknown = {}) => {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    ctx: {
      request: async (method: string, params: unknown) => {
        calls.push({ method: String(method), params })
        return reply
      },
    } as never,
  }
}

const SELECT_MODE = {
  id: "mode",
  type: "select" as const,
  name: "Mode",
  category: "mode",
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "acceptEdits", name: "Accept edits", description: "Edits only" },
    { value: "bypassPermissions", name: "Bypass permissions" },
  ],
}

describe("reading ACP permission modes", () => {
  test("config options are read, with the agent's own names", () => {
    const result = permissionModes(state({ cfg: [SELECT_MODE] as never }))
    expect(result.modes.map((mode) => mode.id)).toEqual(["default", "acceptEdits", "bypassPermissions"])
    expect(result.modes.map((mode) => mode.name)).toEqual(["Default", "Accept edits", "Bypass permissions"])
    expect(result.currentModeId).toBe("default")
    expect(result.appliesFrom).toBe("next-turn")
  })

  // `SessionConfigSelectOptions` is a union: a flat option array OR an array of
  // GROUPS. A naive `.find` over the outer array silently sees zero options in the
  // grouped case, which would render an agent's whole mode list as empty.
  test("grouped select options are flattened rather than missed", () => {
    const grouped = {
      ...SELECT_MODE,
      options: [
        { group: "Safe", options: [{ value: "default", name: "Default" }] },
        { group: "Risky", options: [{ value: "yolo", name: "Yolo" }] },
      ],
    }
    const result = permissionModes(state({ cfg: [grouped] as never }))
    expect(result.modes.map((mode) => mode.id)).toEqual(["default", "yolo"])
  })

  // Matching on `category` rather than the `id` string is what keeps this
  // agent-agnostic: codex-acp and claude-agent-acp happen to use `id: "mode"`, but
  // category is the semantic field.
  test("an option is found by category even when its id is something else", () => {
    const odd = { ...SELECT_MODE, id: "permission-profile", category: "mode" }
    expect(permissionModes(state({ cfg: [odd] as never })).modes).toHaveLength(3)
  })

  test("the legacy set_mode channel is used when there are no config options", () => {
    const result = permissionModes(
      state({
        modes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }] as never,
        currentModeId: "plan",
      }),
    )
    expect(result.modes.map((mode) => mode.id)).toEqual(["code", "plan"])
    expect(result.currentModeId).toBe("plan")
  })

  // Level is a hint for picking a default, never a label. An id nobody recognises
  // stays selectable but is not a default candidate — "we do not know what this
  // does" is the honest outcome, and guessing is what an earlier design got wrong.
  test("recognised ids get a rung, unrecognised ids get none", () => {
    const { modes } = permissionModes(state({ cfg: [SELECT_MODE] as never }))
    expect(modes.find((mode) => mode.id === "default")?.level).toBe("ask")
    expect(modes.find((mode) => mode.id === "bypassPermissions")?.level).toBe("full")
    // `acceptEdits` IS the auto rung: allow edits, still prompt for commands.
    expect(modes.find((mode) => mode.id === "acceptEdits")?.level).toBe("auto")
  })

  test("id matching ignores case and separators", () => {
    const variants = {
      ...SELECT_MODE,
      options: [{ value: "accept_edits", name: "A" }, { value: "FULL-ACCESS", name: "B" }],
    }
    const { modes } = permissionModes(state({ cfg: [variants] as never }))
    expect(modes.find((mode) => mode.id === "accept_edits")?.level).toBe("auto")
    expect(modes.find((mode) => mode.id === "FULL-ACCESS")?.level).toBe("full")
  })

  // An agent with NEITHER channel is unsupported; an agent with a channel that has
  // reported nothing is empty. Collapsing them makes a permanent gap look transient.
  test("no channel at all reads as unsupported, not as empty", () => {
    expect(permissionModes(state({ caps: {} as never })).unsupported).toBeTruthy()
    expect(permissionModes(state({ cfg: [] as never, caps: {} as never })).unsupported).toBeUndefined()
  })
})

describe("writing an ACP permission mode", () => {
  test("a config-option write sends set_config_option with the option's own id", async () => {
    const { ctx, calls } = conn({ configOptions: [{ ...SELECT_MODE, currentValue: "acceptEdits" }] })
    const result = await setPermissionMode(ctx, state({ cfg: [SELECT_MODE] as never }), "ses_a", "acceptEdits")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual({ sessionId: "ses_a", configId: "mode", value: "acceptEdits" })
    expect(result.result.currentModeId).toBe("acceptEdits")
  })

  // The response carries the COMPLETE refreshed option list, so it replaces the
  // stored one. Merging would resurrect options the agent just dropped.
  test("the returned option list replaces the stored one rather than merging", async () => {
    const shrunk = { ...SELECT_MODE, currentValue: "default", options: [{ value: "default", name: "Default" }] }
    const { ctx } = conn({ configOptions: [shrunk] })
    const result = await setPermissionMode(ctx, state({ cfg: [SELECT_MODE] as never }), "ses_a", "default")
    expect(result.result.modes.map((mode) => mode.id)).toEqual(["default"])
  })

  // The agent can keep something other than what was asked for. Echoing the
  // request would make the picker assert a mode that is not running.
  test("a clamped answer is reported, not the requested id", async () => {
    const { ctx } = conn({ configOptions: [{ ...SELECT_MODE, currentValue: "default" }] })
    const result = await setPermissionMode(ctx, state({ cfg: [SELECT_MODE] as never }), "ses_a", "bypassPermissions")
    expect(result.result.currentModeId).toBe("default")
  })

  test("the legacy channel sends set_mode", async () => {
    const { ctx, calls } = conn()
    const before = state({ modes: [{ id: "plan", name: "Plan" }] as never })
    const result = await setPermissionMode(ctx, before, "ses_a", "plan")
    expect(calls[0]!.params).toEqual({ sessionId: "ses_a", modeId: "plan" })
    // set_mode answers with nothing, so the request is recorded optimistically and
    // the next session/update corrects it.
    expect(result.result.currentModeId).toBe("plan")
  })

  // A mode the agent never offered must not be sent. Silently forwarding it would
  // either error deep in the agent or, worse, be accepted as something unintended.
  test("an unknown mode id throws instead of being sent", async () => {
    const { ctx, calls } = conn()
    await expect(setPermissionMode(ctx, state({ cfg: [SELECT_MODE] as never }), "ses_a", "nope")).rejects.toThrow(
      /does not offer/i,
    )
    await expect(setPermissionMode(ctx, state(), "ses_a", "nope")).rejects.toThrow(/does not offer/i)
    expect(calls).toHaveLength(0)
  })
})

describe("currentModeId survives merges", () => {
  test("it is taken from the agent's payload, not carried over blindly", () => {
    const first = merge(init(null), { modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A" }] } })
    expect(first.currentModeId).toBe("a")
    const second = merge(first, { modes: { currentModeId: "b", availableModes: [{ id: "b", name: "B" }] } })
    expect(second.currentModeId).toBe("b")
  })

  test("a merge that carries no modes leaves the current one alone", () => {
    const first = merge(init(null), { modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A" }] } })
    expect(merge(first, { configOptions: [] }).currentModeId).toBe("a")
  })
})
