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

  test("carries the turn's org through mint/resolve (hosted D7 partition input)", () => {
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
})
