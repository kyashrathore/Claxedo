import { describe, expect, test } from "bun:test"
import { principalDataScope, principalHasSignedAccess } from "./identity-provider"

describe("principalHasSignedAccess", () => {
  test("allows local, signed, and org-member principals", () => {
    expect(principalHasSignedAccess({ kind: "local", deviceId: "local" })).toBe(true)
    expect(principalHasSignedAccess({ kind: "signed", userId: "usr_1" })).toBe(true)
    expect(principalHasSignedAccess({
      kind: "org-member",
      userId: "usr_1",
      orgId: "org_1",
      memberships: []
    })).toBe(true)
  })

  test("keeps credential-backed access without inventing a durable subject", () => {
    expect(principalHasSignedAccess({ kind: "signed-unresolved" })).toBe(true)
    expect(principalDataScope({ kind: "signed-unresolved" })).toBeNull()
  })

  test("blocks anonymous principals", () => {
    expect(principalHasSignedAccess({ kind: "anonymous" })).toBe(false)
  })
})
