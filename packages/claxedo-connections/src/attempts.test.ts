import { describe, expect, test } from "bun:test"
import { createAttempts } from "./attempts.js"

describe("attempt machine", () => {
  test("consume is single-use and atomic", () => {
    const attempts = createAttempts({ sweepIntervalMs: 0 })
    const { state, verifier } = attempts.create({ integrationId: "fake", scope: "team" })
    expect(state.length).toBeGreaterThanOrEqual(43) // 32 bytes base64url
    const first = attempts.consume(state)
    expect(first).toEqual({ integrationId: "fake", scope: "team", verifier })
    expect(attempts.consume(state)).toBeUndefined()
    attempts.dispose()
  })

  test("unknown and settled states are rejected", () => {
    const attempts = createAttempts({ sweepIntervalMs: 0 })
    expect(attempts.consume("nope")).toBeUndefined()
    const { state } = attempts.create({ integrationId: "fake", scope: "team" })
    attempts.consume(state)
    attempts.settle(state, false, "callback_failed")
    expect(attempts.consume(state)).toBeUndefined()
    expect(attempts.status(state)).toMatchObject({ status: "failed", message: "callback_failed" })
    attempts.dispose()
  })

  test("expiry: pending past TTL cannot be consumed; sweep transitions then deletes", () => {
    let ts = 0
    const attempts = createAttempts({ sweepIntervalMs: 0, ttlMs: 100, retentionMs: 50, now: () => ts })
    const { state } = attempts.create({ integrationId: "fake", scope: "team" })
    ts = 101
    expect(attempts.consume(state)).toBeUndefined()
    expect(attempts.status(state)).toMatchObject({ status: "expired" })
    ts = 200
    attempts.sweep()
    expect(attempts.status(state)).toBeUndefined()
    attempts.dispose()
  })

  test("settle after success reports complete", () => {
    const attempts = createAttempts({ sweepIntervalMs: 0 })
    const { state } = attempts.create({ integrationId: "fake", scope: "team" })
    attempts.consume(state)
    attempts.settle(state, true)
    expect(attempts.status(state)).toMatchObject({ status: "complete", integrationId: "fake" })
    attempts.dispose()
  })
})
