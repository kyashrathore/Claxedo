import { describe, expect, test } from "bun:test"
import type { PermissionOption } from "@agentclientprotocol/sdk"
import { acpPermissionRequest, permissionOptionPreference, selectPermissionOption } from "./permission-options"

const option = (kind: PermissionOption["kind"], optionId: string = kind): PermissionOption =>
  ({ kind, optionId, name: kind }) as PermissionOption

const ALL: PermissionOption[] = [
  option("allow_once"),
  option("allow_always"),
  option("reject_once"),
  option("reject_always"),
]

describe("selectPermissionOption — exact matches", () => {
  test("each decision takes its own kind when the agent offers it", () => {
    expect(selectPermissionOption("allow_once", ALL)?.kind).toBe("allow_once")
    expect(selectPermissionOption("allow_always", ALL)?.kind).toBe("allow_always")
    expect(selectPermissionOption("deny", ALL)?.kind).toBe("reject_once")
    expect(selectPermissionOption("reject_always", ALL)?.kind).toBe("reject_always")
  })

  test("returns the agent's own optionId, not the kind", () => {
    const selected = selectPermissionOption("allow_always", [option("allow_always", "cursor-opt-7")])
    expect(selected?.optionId).toBe("cursor-opt-7")
  })
})

describe("selectPermissionOption — narrowing a grant is allowed", () => {
  // A narrower grant keeps the tool call within the advertised option set.
  test("allow_always degrades to allow_once when the agent has no always option", () => {
    const selected = selectPermissionOption("allow_always", [option("allow_once"), option("reject_once")])
    expect(selected?.kind).toBe("allow_once")
  })

  test("reject_always degrades to reject_once", () => {
    expect(selectPermissionOption("reject_always", [option("reject_once")])?.kind).toBe("reject_once")
  })
})

describe("selectPermissionOption — widening a GRANT is forbidden", () => {
  // The security-relevant direction: a one-time grant must never become standing
  // permission just because the agent did not offer a once option.
  test("allow_once never escalates to allow_always", () => {
    expect(selectPermissionOption("allow_once", [option("allow_always")])).toBeUndefined()
    expect(permissionOptionPreference("allow_once")).toEqual(["allow_once"])
  })

  test("allow_once yields nothing rather than any allow it can find", () => {
    const selected = selectPermissionOption("allow_once", [option("allow_always"), option("reject_always")])
    expect(selected).toBeUndefined()
  })
})

describe("selectPermissionOption — widening a DENIAL is fail-safe", () => {
  test("deny escalates to reject_always when reject_once is absent", () => {
    // A broader "no" is still a "no"; cancelling would let the agent retry.
    expect(selectPermissionOption("deny", [option("reject_always")])?.kind).toBe("reject_always")
  })

  test("deny prefers reject_once when both are present", () => {
    expect(selectPermissionOption("deny", ALL)?.kind).toBe("reject_once")
  })
})

describe("selectPermissionOption — nothing acceptable", () => {
  test("an empty option list yields undefined for every decision", () => {
    for (const decision of ["allow_once", "allow_always", "deny", "reject_always"] as const) {
      expect(selectPermissionOption(decision, [])).toBeUndefined()
    }
  })

  test("an allow decision never falls through to a reject option", () => {
    expect(selectPermissionOption("allow_always", [option("reject_once"), option("reject_always")])).toBeUndefined()
    expect(selectPermissionOption("allow_once", [option("reject_once")])).toBeUndefined()
  })

  test("a deny decision never falls through to an allow option", () => {
    expect(selectPermissionOption("deny", [option("allow_once"), option("allow_always")])).toBeUndefined()
    expect(selectPermissionOption("reject_always", [option("allow_always")])).toBeUndefined()
  })

  test("unknown kinds the agent invents are ignored", () => {
    const weird = [{ kind: "something_else", optionId: "x", name: "x" }] as unknown as PermissionOption[]
    expect(selectPermissionOption("allow_always", weird)).toBeUndefined()
  })
})

describe("permissionOptionPreference", () => {
  test("every decision has at least one acceptable kind, most-preferred first", () => {
    for (const decision of ["allow_once", "allow_always", "deny", "reject_always"] as const) {
      const preference = permissionOptionPreference(decision)
      expect(preference.length).toBeGreaterThan(0)
      expect(new Set(preference).size).toBe(preference.length)
    }
  })

  test("no preference list mixes allow and reject kinds", () => {
    for (const decision of ["allow_once", "allow_always"] as const) {
      expect(permissionOptionPreference(decision).every((kind) => kind.startsWith("allow"))).toBe(true)
    }
    for (const decision of ["deny", "reject_always"] as const) {
      expect(permissionOptionPreference(decision).every((kind) => kind.startsWith("reject"))).toBe(true)
    }
  })
})

describe("acpPermissionRequest — the classification, not the prose", () => {
  const base = { permId: "p1", sessionId: "s1", tool: "Read file src/index.ts", paths: ["/w/src/index.ts"] }

  // Policy uses the protocol classification rather than human-readable prose.
  test("permission is the ToolKind, never the human title", () => {
    const req = acpPermissionRequest({ ...base, kind: "read" })
    expect(req.permission).toBe("read")
    expect(req.permission).not.toBe(base.tool)
  })

  test("the human title is preserved in metadata rather than discarded", () => {
    expect(acpPermissionRequest({ ...base, kind: "execute" }).metadata).toEqual({ title: base.tool })
  })

  // Fail-safe: an unclassified request must land in the ask tier, not inherit
  // whatever the title happened to spell.
  test("an absent kind becomes 'other', which is never auto-approved", () => {
    expect(acpPermissionRequest(base).permission).toBe("other")
  })

  test("every ToolKind round-trips unchanged into permission", () => {
    const kinds = [
      "read", "edit", "delete", "move", "search",
      "execute", "think", "fetch", "switch_mode", "other",
    ] as const
    for (const kind of kinds) {
      expect(acpPermissionRequest({ ...base, kind }).permission).toBe(kind)
    }
  })

  test("paths flow to both patterns and always; ids are passed through", () => {
    const req = acpPermissionRequest({ ...base, kind: "edit" })
    expect(req.patterns).toEqual(base.paths)
    expect(req.always).toEqual(base.paths)
    expect(req.id).toBe("p1")
    expect(req.sessionID).toBe("s1")
  })
})
