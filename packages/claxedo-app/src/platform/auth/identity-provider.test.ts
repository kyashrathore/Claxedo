import { describe, expect, test } from "bun:test"
import { principalHasSignedAccess } from "./identity-provider"

describe("principalHasSignedAccess", () => {
  test("allows local, signed, and org-member principals", () => {
    expect(principalHasSignedAccess({ kind: "local", deviceId: "local" })).toBe(true)
    expect(principalHasSignedAccess({ kind: "signed", userId: "usr_1" })).toBe(true)
    expect(
      principalHasSignedAccess({
        kind: "org-member",
        userId: "usr_1",
        orgId: "org_1",
        memberships: [],
      }),
    ).toBe(true)
  })

  test("blocks anonymous principals", () => {
    expect(principalHasSignedAccess({ kind: "anonymous" })).toBe(false)
  })
})
