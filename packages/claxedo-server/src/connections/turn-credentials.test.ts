import { describe, expect, test } from "vitest"
import { createConnectionTurnCredentials } from "./turn-credentials"

describe("connection turn credentials", () => {
  test("resolve only until expiry and preserves whether the turn is interactive", () => {
    let now = 1
    let next = 0
    const credentials = createConnectionTurnCredentials({
      now: () => now,
      ttlMs: 100,
      random: () => `credential-${++next}`,
    })
    const interactive = credentials.mint({ sessionId: "session-1", subject: "user-a" })
    const unattended = credentials.mint({ sessionId: "session-1" })

    expect(credentials.resolve(interactive)).toEqual({ sessionId: "session-1", subject: "user-a" })
    expect(credentials.resolve(unattended)).toEqual({ sessionId: "session-1" })
    now = 101
    expect(credentials.resolve(interactive)).toBeUndefined()
    credentials.dispose()
  })

  test("carries the turn's org through mint/resolve (hosted partition input)", () => {
    let next = 0
    const credentials = createConnectionTurnCredentials({ random: () => `credential-${++next}` })
    const orgTurn = credentials.mint({ sessionId: "session-1", subject: "user-a", orgId: "org-a" })
    expect(credentials.resolve(orgTurn)).toEqual({ sessionId: "session-1", subject: "user-a", orgId: "org-a" })
    // Org-less turns stay org-less: nothing invents a tenant.
    const plain = credentials.mint({ sessionId: "session-1", subject: "user-a" })
    expect(credentials.resolve(plain)).toEqual({ sessionId: "session-1", subject: "user-a" })
    credentials.dispose()
  })

  test("keeps concurrent turn context isolated", async () => {
    const credentials = createConnectionTurnCredentials({ random: (() => {
      let next = 0
      return () => `credential-${++next}`
    })() })
    const interactive = credentials.mint({ sessionId: "session-1", subject: "user-a" })
    const unattended = credentials.mint({ sessionId: "session-1" })

    const [currentInteractive, currentUnattended] = await Promise.all([
      credentials.run(interactive, async () => {
        await Promise.resolve()
        return credentials.current()
      }),
      credentials.run(unattended, async () => {
        await Promise.resolve()
        return credentials.current()
      }),
    ])
    expect(currentInteractive).toBe(interactive)
    expect(currentUnattended).toBe(unattended)
    credentials.dispose()
  })

  test("lease-bound mints die at the lease deadline and track renewal and release", () => {
    let now = 1_000
    let next = 0
    const credentials = createConnectionTurnCredentials({
      now: () => now,
      random: () => `credential-${++next}`,
    })
    const minted = credentials.mint({
      sessionId: "session-1",
      subject: "user-a",
      leaseId: "lease_1",
      expiresAt: 2_000,
    })
    expect(credentials.resolve(minted)).toEqual({ sessionId: "session-1", subject: "user-a" })

    // Renewal hands the holder the same credential, now bounded by the
    // renewed lease — including when the authority rotated the lease id.
    expect(credentials.extendLease("lease_1", { leaseId: "lease_2", expiresAt: 5_000 }))
      .toBe(minted)
    now = 2_500
    expect(credentials.resolve(minted)).toEqual({ sessionId: "session-1", subject: "user-a" })

    credentials.revokeLease("lease_1")
    expect(credentials.resolve(minted)).toEqual({ sessionId: "session-1", subject: "user-a" })
    credentials.revokeLease("lease_2")
    expect(credentials.resolve(minted)).toBeUndefined()
    credentials.dispose()
  })

  test("a lease-bound mint retires the credential a superseded turn left behind", () => {
    let next = 0
    const credentials = createConnectionTurnCredentials({ random: () => `credential-${++next}` })
    const stale = credentials.mint({ sessionId: "session-1", subject: "user-a", leaseId: "lease_1", expiresAt: Date.now() + 60_000 })
    const live = credentials.mint({ sessionId: "session-1", subject: "user-a", leaseId: "lease_2", expiresAt: Date.now() + 60_000 })

    expect(credentials.resolve(stale)).toBeUndefined()
    expect(credentials.resolve(live)).toEqual({ sessionId: "session-1", subject: "user-a" })
    credentials.dispose()
  })
})
