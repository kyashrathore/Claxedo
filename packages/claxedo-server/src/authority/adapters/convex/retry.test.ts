/**
 * W4.1 acceptance: retries with jitter, on idempotent operations ONLY.
 *
 * The two claims that need teeth, and each carries its positive control in the
 * same test:
 *
 *   1. An eligible failure (timeout / 5xx) is retried. Control: the same
 *      sequence with `maxRetries: 0` is asserted to fail, so a green "retry
 *      worked" cannot be a call that simply never failed.
 *   2. A NON-idempotent write that times out is NOT retried. This is the
 *      dangerous direction: `withTimeout` does not cancel the fetch, so the
 *      first mutation may still be in flight and committing. Control: the
 *      identical stub, marked `idempotent: true`, IS retried — proving the
 *      single attempt came from the eligibility rule and not from a stub that
 *      forgot to fail.
 */

import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "../../auth"
import {
  CONVEX_RETRY_BASE_DELAY_MS,
  CONVEX_RETRY_MAX_DELAY_MS,
  convexRetryDelayMs,
  isRetryableConvexError,
  withConvexRetry,
} from "./retry"
import { mutationIsReplaySafe } from "./workspace-authority/executor"
import { ControlPlaneRequestTimeoutError } from "./timeout"

/** No real sleeping; the delays handed to it are asserted directly. */
function recordingSleep() {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

/**
 * `ControlPlaneAuthError` only accepts the statuses the control plane actually
 * emits, so the retryable/terminal split is exercised with the two it has: the
 * 503 the executor synthesizes for a timeout, and a 403 denial.
 */
function serverError(status: 403 | 503) {
  return new ControlPlaneAuthError(status, "workspace_authority_unavailable", `upstream ${status}`)
}

describe("W4.1 Convex retry eligibility", () => {
  test("a read that 5xxs once then succeeds succeeds with exactly one retry", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(serverError(503))
      .mockResolvedValueOnce("fresh")
    const { sleep, delays } = recordingSleep()

    await expect(
      withConvexRetry({ idempotent: true, attempt }, { sleep, random: () => 0 }),
    ).resolves.toBe("fresh")
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([CONVEX_RETRY_BASE_DELAY_MS / 2])

    // POSITIVE CONTROL: retries disabled, same failing-then-succeeding stub.
    // If this passed, the test above would prove nothing about retry.
    const control = vi.fn()
      .mockRejectedValueOnce(serverError(503))
      .mockResolvedValueOnce("fresh")
    await expect(
      withConvexRetry({ idempotent: true, attempt: control }, { sleep, maxRetries: 0 }),
    ).rejects.toThrow("upstream 503")
    expect(control).toHaveBeenCalledTimes(1)
  })

  test("a non-idempotent write that times out is NOT retried", async () => {
    // The hazard: withTimeout bounds the caller's wait but does not cancel the
    // fetch, so attempt #1 may still commit. A second attempt would double it.
    const write = vi.fn().mockRejectedValue(new ControlPlaneRequestTimeoutError())
    const { sleep, delays } = recordingSleep()

    await expect(
      withConvexRetry({ idempotent: false, attempt: write }, { sleep }),
    ).rejects.toBeInstanceOf(ControlPlaneRequestTimeoutError)
    expect(write).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])

    // POSITIVE CONTROL: the SAME always-timing-out stub, marked idempotent, is
    // retried. So the single attempt above came from the eligibility rule, not
    // from an error shape that happens to be unretryable.
    const guarded = vi.fn().mockRejectedValue(new ControlPlaneRequestTimeoutError())
    await expect(
      withConvexRetry({ idempotent: true, attempt: guarded }, { sleep }),
    ).rejects.toBeInstanceOf(ControlPlaneRequestTimeoutError)
    expect(guarded).toHaveBeenCalledTimes(2)
  })

  test("a 4xx is terminal even for an idempotent operation", async () => {
    // Replaying a rejected-on-its-merits request buys a guaranteed identical
    // rejection and spends the budget that a real transient failure needs.
    const denied = vi.fn().mockRejectedValue(
      new ControlPlaneAuthError(403, "workspace_authorization_denied", "denied"),
    )
    await expect(
      withConvexRetry({ idempotent: true, attempt: denied }, { sleep: async () => {} }),
    ).rejects.toThrow("denied")
    expect(denied).toHaveBeenCalledTimes(1)
  })

  test("an unclassifiable error is terminal", async () => {
    // Guessing "probably transient" from an unknown error is exactly how an
    // unguarded write gets replayed.
    expect(isRetryableConvexError(new Error("something odd"))).toBe(false)
    expect(isRetryableConvexError(undefined)).toBe(false)
    expect(isRetryableConvexError(serverError(503))).toBe(true)
    expect(isRetryableConvexError(serverError(403))).toBe(false)
    // A 409 from the idempotency layer is terminal too: replaying it cannot
    // change the payload that conflicted.
    expect(isRetryableConvexError({ status: 409, code: "control_plane_idempotency_payload_mismatch" })).toBe(false)
    expect(isRetryableConvexError(new ControlPlaneRequestTimeoutError())).toBe(true)
    expect(isRetryableConvexError({ name: "TimeoutError", message: "fetch timed out" })).toBe(true)
  })

  test("backoff grows exponentially and jitters within the top half of the window", async () => {
    // Lockstep retries turn one Convex blip into a synchronized second wave, so
    // the jitter is load-bearing, not decoration.
    expect(convexRetryDelayMs(0, () => 0)).toBe(CONVEX_RETRY_BASE_DELAY_MS / 2)
    expect(convexRetryDelayMs(0, () => 1)).toBe(CONVEX_RETRY_BASE_DELAY_MS)
    expect(convexRetryDelayMs(1, () => 0)).toBe(CONVEX_RETRY_BASE_DELAY_MS)
    expect(convexRetryDelayMs(50, () => 1)).toBe(CONVEX_RETRY_MAX_DELAY_MS)

    // Distinct random draws must produce distinct delays — a "jitter" that
    // ignores its random source would still pass the bounds checks above.
    const draws = [0.1, 0.5, 0.9].map((value) => convexRetryDelayMs(3, () => value))
    expect(new Set(draws).size).toBe(3)
  })

  test("only args naming a server-side idempotency key mark a mutation replay-safe", () => {
    expect(mutationIsReplaySafe({ operation_id: "op_1" })).toBe(true)
    expect(mutationIsReplaySafe({ idempotency_key: "k_1" })).toBe(true)
    expect(mutationIsReplaySafe({ source_ts: 1 })).toBe(true)
    // A plain write. Nothing here lets the server recognize a second delivery.
    expect(mutationIsReplaySafe({ workspace_id: "ws_1", title: "hello" })).toBe(false)
    // Present-but-undefined is absent: `...(x ? { operation_id: x } : {})` is
    // the repo's spread idiom and must not read as a guarantee.
    expect(mutationIsReplaySafe({ operation_id: undefined })).toBe(false)
  })
})
