import { describe, expect, test } from "vitest"
import { createConvexConnectionAttempts } from "./connection-attempts"

/**
 * The adapter's job is to speak the kit's `Attempts` port over Convex.
 * `convex/connection-attempts.policy.test.ts` owns the STORE semantics
 * (expiry, single-use consume, sweep); what is left to pin here is the wiring:
 * the service token travels on every call, `now` is supplied by the caller,
 * `null` is normalized to `undefined`, and — the one that reintroduces the
 * original bug if it regresses — `dispose()` destroys nothing.
 */
function harness(responses: {
  query?: unknown
  mutation?: unknown
} = {}) {
  const calls: Array<{ kind: "query" | "mutation"; args: Record<string, unknown> }> = []
  const executor = {
    async query(_fn: unknown, args: Record<string, unknown>) {
      calls.push({ kind: "query", args })
      return responses.query ?? null
    },
    async mutation(_fn: unknown, args: Record<string, unknown>) {
      calls.push({ kind: "mutation", args })
      return responses.mutation ?? null
    },
  }
  let issued = 0
  const attempts = createConvexConnectionAttempts({
    executor,
    serviceToken: "svc_secret",
    now: () => 1_000,
    newToken: () => `token_${++issued}`,
  })
  return { attempts, calls }
}

describe("Convex connection attempts adapter", () => {
  test("create mints its own state/verifier and writes them with the service token", async () => {
    const { attempts, calls } = harness()

    await expect(attempts.create({ integrationId: "github", scope: "team" }))
      .resolves.toEqual({ state: "token_1", verifier: "token_2" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual({
      service_token: "svc_secret",
      state: "token_1",
      verifier: "token_2",
      integration_id: "github",
      scope: "team",
      now: 1_000,
    })
  })

  test("a device grant carries its device code; a personal attempt carries its owner", async () => {
    const { attempts, calls } = harness()

    await attempts.create({ integrationId: "github", scope: "personal", owner: "user_7", deviceCode: "device_1" })

    expect(calls[0]!.args).toMatchObject({ device_code: "device_1", owner: "user_7", scope: "personal" })
  })

  test("absent optional fields are omitted rather than sent as undefined", async () => {
    // Convex validators reject an explicit `undefined` for an optional arg, so
    // spreading the key in unconditionally would fail at runtime only — and
    // only on the team/redirect path, which is the common one.
    const { attempts, calls } = harness()

    await attempts.create({ integrationId: "github", scope: "team" })

    expect(Object.keys(calls[0]!.args)).not.toContain("device_code")
    expect(Object.keys(calls[0]!.args)).not.toContain("owner")
  })

  test("consume and peek normalize the store's null miss to undefined", async () => {
    // The port's contract is `undefined` for a miss; a leaked `null` is truthy
    // in the service's `if (!await attempts.consume(state))` guard's negation
    // and would settle an attempt that was never claimed.
    const { attempts } = harness({ mutation: null })

    await expect(attempts.consume("state_1")).resolves.toBeUndefined()
    await expect(attempts.peek("state_1")).resolves.toBeUndefined()
  })

  test("status reads through the query seam and normalizes a miss", async () => {
    const found = harness({ query: { status: "complete", integrationId: "github", scope: "team" } })
    await expect(found.attempts.status("state_1"))
      .resolves.toEqual({ status: "complete", integrationId: "github", scope: "team" })
    expect(found.calls[0]).toMatchObject({ kind: "query", args: { service_token: "svc_secret", state: "state_1" } })

    const missing = harness({ query: null })
    await expect(missing.attempts.status("state_1")).resolves.toBeUndefined()
  })

  test("settle sends its message only when there is one, and expire is its own call", async () => {
    const { attempts, calls } = harness()

    await attempts.settle("state_1", false, "device_denied")
    await attempts.settle("state_2", true)
    await attempts.expire("state_3")

    expect(calls[0]!.args).toMatchObject({ state: "state_1", ok: false, message: "device_denied" })
    expect(Object.keys(calls[1]!.args)).not.toContain("message")
    expect(calls[1]!.args).toMatchObject({ state: "state_2", ok: true })
    expect(calls[2]!.args).toEqual({ service_token: "svc_secret", state: "state_3", now: 1_000 })
  })

  test("dispose destroys nothing — the hosted setup calls it after EVERY request", async () => {
    // This is the regression that would restore the original bug in a new
    // shape: if dispose deleted rows, the attempt created by
    // `POST /:id/connect` would be gone before `GET /attempts/:state` ran.
    const { attempts, calls } = harness()

    attempts.dispose()
    attempts.sweep()

    expect(calls).toEqual([])
  })

  test("state and verifier are unpredictable by default", async () => {
    // The default token source is Web Crypto; a weak or repeating state would
    // let one user's callback settle another's attempt.
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const attempts = createConvexConnectionAttempts({
        executor: { query: async () => null, mutation: async () => null },
        serviceToken: "svc_secret",
      })
      const { state, verifier } = await attempts.create({ integrationId: "github", scope: "team" })
      expect(state).not.toEqual(verifier)
      // 32 bytes base64url, matching what the kit's in-memory store mints.
      expect(state.length).toBeGreaterThanOrEqual(43)
      seen.add(state)
    }
    expect(seen.size).toBe(5)
  })
})
