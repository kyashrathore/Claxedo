import { describe, expect, test } from "bun:test"
import { acpPermissionGrant, hasAcpGrant, readAcpGrants, withAcpGrant, type AcpPermissionGrant } from "./permission-grants"

describe("ACP permission grants", () => {
  const run: AcpPermissionGrant = { kind: "execute", tool: "bun test src" }

  test("an absent kind is remembered as 'other', never as a wildcard", () => {
    expect(acpPermissionGrant({ tool: "mystery" })).toEqual({ kind: "other", tool: "mystery" })
  })

  test("an untitled request yields no grant, so it can never be answered on the user's behalf", () => {
    expect(acpPermissionGrant({ kind: "execute" })).toBeUndefined()
    expect(acpPermissionGrant({ kind: "execute", tool: "" })).toBeUndefined()
  })

  test("a grant matches only the same kind and the same title", () => {
    const state = withAcpGrant(undefined, run)
    expect(hasAcpGrant(state, run)).toBe(true)
    expect(hasAcpGrant(state, { kind: "execute", tool: "bun test src/other" })).toBe(false)
    expect(hasAcpGrant(state, { kind: "read", tool: "bun test src" })).toBe(false)
    expect(hasAcpGrant(undefined, run)).toBe(false)
  })

  test("saving keeps the rest of the permission state and never duplicates", () => {
    const state = withAcpGrant({ codexCommandGrants: [{ directory: "/w" }] }, run)
    expect(state.codexCommandGrants).toEqual([{ directory: "/w" }])
    expect(withAcpGrant(state, run)).toBe(state)
    expect(readAcpGrants(withAcpGrant(state, { kind: "edit", tool: "Edit a.ts" }))).toHaveLength(2)
  })

  test("malformed persisted rows are ignored rather than trusted", () => {
    expect(readAcpGrants({ acpGrants: [null, 1, { kind: "execute" }, { kind: "launch", tool: "ls" }, { kind: "execute", tool: "ls" }] }))
      .toEqual([{ kind: "execute", tool: "ls" }])
    expect(readAcpGrants({ acpGrants: "ls" })).toEqual([])
  })
})
