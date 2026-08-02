import { describe, expect, test } from "bun:test"
import { CONTENT_TYPES } from "../state/types"
import { SWITCHER_KINDS, mapKindFromMeta } from "./switcher-items"

// Guards against SwitcherKind carrying variants mapKindFromMeta can never
// produce (the "browser"/"review"/"file"/"processes" dead-variant bug found
// in the OSS-quality audit) and against mapKindFromMeta silently gaining a
// return value SwitcherKind doesn't declare.

describe("SwitcherKind <-> ContentType parity", () => {
  test("mapKindFromMeta(type) returns a declared SwitcherKind for every live ContentType", () => {
    for (const type of CONTENT_TYPES) {
      const kind = mapKindFromMeta(type)
      expect(SWITCHER_KINDS).toContain(kind)
    }
  })

  test("mapKindFromMeta's reachable output set matches SWITCHER_KINDS exactly (no unreachable SwitcherKind variants)", () => {
    const reachable = new Set(CONTENT_TYPES.map((type) => mapKindFromMeta(type)))
    expect([...reachable].sort()).toEqual([...SWITCHER_KINDS].sort())
  })

  test("draft-session and session content both map to the session switcher kind", () => {
    expect(mapKindFromMeta("session")).toBe("session")
    expect(mapKindFromMeta("draft-session")).toBe("session")
  })

  test("page and pages-index content both map to the page switcher kind", () => {
    expect(mapKindFromMeta("page")).toBe("page")
    expect(mapKindFromMeta("pages-index")).toBe("page")
  })

  test("context content maps to the page switcher kind", () => {
    expect(mapKindFromMeta("context")).toBe("page")
  })

  test("terminal and marketplace content map to their own-named switcher kind", () => {
    expect(mapKindFromMeta("terminal")).toBe("terminal")
    expect(mapKindFromMeta("marketplace")).toBe("marketplace")
  })
})
