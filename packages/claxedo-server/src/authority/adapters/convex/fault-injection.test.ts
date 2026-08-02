/**
 * W4 acceptance: a hanging Convex fails FAST with a 503 instead of holding the
 * request.
 *
 * ## Why this is worth its own test
 *
 * `timeout.test.ts` proves `withTimeout` rejects on schedule. It does not prove
 * that the executor the routes actually call is wired through it — and that
 * wiring is the whole property. The fault here is injected at the layer a real
 * outage hits: `fetch` never settles, exactly as it behaves when Convex accepts
 * a connection and then goes silent.
 *
 * The positive control is the same hanging fetch with the timeout removed,
 * asserted to still be pending after the deadline. Without it, a green "rejected
 * with 503" could be a stub that rejected on its own.
 *
 * ## The sharp edge this test also pins
 *
 * `withTimeout` bounds the CALLER's wait; it does not cancel the fetch. So after
 * the 503 the underlying request may still be in flight and may still commit.
 * The last test asserts the consequence: an unguarded mutation is NOT retried
 * after a timeout, because a retry would be a second concurrent execution rather
 * than a second attempt. That is what makes durable idempotency (W4.2) the
 * partner of this timeout rather than an alternative to it.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { requireExecutor } from "./workspace-authority/executor"

const originalFetch = globalThis.fetch

/** A Convex that accepts the connection and then never answers. */
function hangingFetch() {
  const calls = { count: 0 }
  globalThis.fetch = ((..._args: unknown[]) => {
    calls.count += 1
    return new Promise<Response>(() => {})
  }) as typeof globalThis.fetch
  return calls
}

function executor() {
  // `allowUnsigned` keeps this focused on the transport: the auth posture is
  // covered elsewhere and is not what is under test.
  return requireExecutor({ url: "https://convex.test" }, undefined, { allowUnsigned: true })
}

describe("W4 fault injection: a hanging Convex", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  test("a hung read fails fast with a typed 503 instead of holding the request", async () => {
    hangingFetch()
    vi.useFakeTimers()

    const pending = executor().query("workspaces:get", { workspace_id: "ws_1" })
    const rejection = expect(pending).rejects.toMatchObject({
      status: 503,
      code: "workspace_authority_unavailable",
    })

    // The read deadline is 5s; reads also get one retry, so allow both attempts.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_100)
    await rejection

    // POSITIVE CONTROL: the same hanging fetch with nothing bounding it is still
    // pending well past the deadline — which is what the request did before the
    // timeout existed.
    const unbounded = globalThis.fetch("https://convex.test", { method: "POST" })
    let settled = false
    void unbounded.then(() => {
      settled = true
    }, () => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
  })

  test("a hung mutation fails fast and is NOT retried when nothing makes it replay-safe", async () => {
    const calls = hangingFetch()
    vi.useFakeTimers()

    // No operationId / idempotency key / source_ts: replaying this would run the
    // write a second time while the first may still be committing, because the
    // timeout did not cancel it.
    const pending = executor().mutation("sessions:upsertVisibility", {
      workspace_id: "ws_1",
      session_id: "session_1",
    })
    const rejection = expect(pending).rejects.toMatchObject({ status: 503 })

    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    // Exactly one attempt reached the network.
    expect(calls.count).toBe(1)
  })

  test("a hung read IS retried, so the single mutation attempt above is the rule and not the transport", async () => {
    // Control for the test above: same hanging transport, a read instead of an
    // unguarded write. Two attempts prove the single attempt above came from the
    // eligibility rule rather than from a transport that only ever fires once.
    const calls = hangingFetch()
    vi.useFakeTimers()

    const pending = executor().query("workspaces:get", { workspace_id: "ws_1" })
    const rejection = expect(pending).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_100)
    await rejection

    expect(calls.count).toBe(2)
  })

  test("a hung mutation IS retried when its args carry an operation id", async () => {
    const calls = hangingFetch()
    vi.useFakeTimers()

    // `operation_id` is the org-deletion cascade's lease/receipt key: Convex
    // returns the recorded result for a replayed id instead of re-running it, so
    // a second delivery is safe.
    const pending = executor().mutation("orgs:finalizeDeletion", {
      org_id: "org_1",
      operation_id: "op_1",
    })
    const rejection = expect(pending).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(10_100)
    await rejection

    // Two attempts REACHED THE NETWORK, which is a stronger claim than "retry
    // was attempted" and is what this assertion is really for.
    //
    // This test caught a live bug during W4.1: `ConvexHttpClient.mutation`
    // queues on the client instance and drains serially, and `withTimeout` does
    // not cancel the fetch — so a retry issued on the same client sat in the
    // queue behind the still-hung first request and `calls.count` stayed at 1.
    // The fix is a fresh client per ATTEMPT (see `executor()`), and this
    // assertion is what keeps it fixed: a regression to a per-call client shows
    // up here as 1, not as a slow test.
    expect(calls.count).toBe(2)
  })
})
