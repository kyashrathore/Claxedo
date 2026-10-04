import { describe, expect, test } from "bun:test"

import { remoteAccessFollow } from "./account-follow"

const signed = { status: "signed" as const, identity: { userId: "u" } }
const unsigned = { status: "unsigned" as const }
const unreachable = { status: "unavailable" as const, reason: "callback-failed" as const, detail: "unreachable", transient: true as const }
const refused = { status: "unavailable" as const, reason: "callback-failed" as const, detail: "refused" }
const revoked = { status: "unavailable" as const, reason: "revoked" as const, detail: "revoked" }

describe("remote access follows the account", () => {
  /** One connection reset must not take the machine offline. */
  test("holds through a transient outage of the control plane", () => {
    expect(remoteAccessFollow(signed, unreachable)).toBe("hold")
    expect(remoteAccessFollow(unreachable, signed)).toBe("hold")
  })

  test("suspends on a verdict: signed out, refused, revoked", () => {
    expect(remoteAccessFollow(signed, unsigned)).toBe("suspend")
    expect(remoteAccessFollow(signed, refused)).toBe("suspend")
    expect(remoteAccessFollow(signed, revoked)).toBe("suspend")
  })

  test("resumes only when a verdict-stopped account is signed again", () => {
    expect(remoteAccessFollow(unsigned, signed)).toBe("resume")
    expect(remoteAccessFollow(refused, signed)).toBe("resume")
    expect(remoteAccessFollow(signed, signed)).toBe("hold")
    expect(remoteAccessFollow(unsigned, unsigned)).toBe("hold")
  })
})
