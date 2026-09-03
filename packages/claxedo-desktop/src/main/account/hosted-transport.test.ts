import { describe, expect, test } from "bun:test"
import { DeadlineExceededError, fetchHosted, fetchWithDeadline } from "./hosted-transport"

const INIT_GET = { method: "GET", headers: { authorization: "Bearer t" } }
const INIT_POST = { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" }
const FAST_DEADLINE = 40

function tracker() {
  const active = new Set<AbortController>()
  return {
    active,
    track: (controller: AbortController) => {
      active.add(controller)
      return () => active.delete(controller)
    },
  }
}

describe("fetchWithDeadline", () => {
  // `fetchHosted` below exercises the shape every hosted call uses; this
  // covers the primitive's own knobs directly, since `electron-seams.ts`'s
  // token transport calls `fetchWithDeadline` with a plain deadline (no
  // `track`) and `refTimer: true`.
  test("returns the response when it arrives before the deadline", async () => {
    const response = await fetchWithDeadline(
      async () => Response.json({ ok: true }),
      "https://core.example/api/auth/oauth2/token",
      { method: "POST", headers: {} },
      50,
    )
    expect(await response.json()).toEqual({ ok: true })
  })

  test("with refTimer: true, still fires the deadline (a ref'd timer times out, it does not hang)", async () => {
    let aborted = false
    await expect(
      fetchWithDeadline(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              aborted = true
              reject(new Error("socket destroyed"))
            })
          }),
        "https://core.example/api/auth/oauth2/token",
        { method: "POST", headers: {} },
        20,
        { refTimer: true },
      ),
    ).rejects.toThrow(DeadlineExceededError)
    expect(aborted).toBe(true)
  })
})

describe("fetchHosted", () => {
  test("returns the response from a single attempt", async () => {
    const { track } = tracker()
    let attempts = 0
    const response = await fetchHosted(
      async () => {
        attempts += 1
        return Response.json({ ok: true })
      },
      "https://core.example/api/claxedo/bootstrap",
      INIT_GET,
      track,
      undefined,
      FAST_DEADLINE,
    )
    expect(await response.json()).toEqual({ ok: true })
    expect(attempts).toBe(1)
  })

  test("never retries a GET that produces no response before the deadline", async () => {
    const { track } = tracker()
    let attempts = 0
    await expect(
      fetchHosted(
        (_url, init) => {
          attempts += 1
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("socket destroyed")))
          })
        },
        "https://core.example/api/claxedo/bootstrap",
        INIT_GET,
        track,
        undefined,
        FAST_DEADLINE,
      ),
    ).rejects.toThrow(DeadlineExceededError)
    expect(attempts).toBe(1)
  })

  test("never retries a mutation, and bounds it by the same deadline", async () => {
    const { track } = tracker()
    let attempts = 0
    await expect(
      fetchHosted(
        (_url, init) => {
          attempts += 1
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("socket destroyed")))
          })
        },
        "https://core.example/api/workspace/create",
        INIT_POST,
        track,
        undefined,
        FAST_DEADLINE,
      ),
    ).rejects.toThrow(DeadlineExceededError)
    expect(attempts).toBe(1)
  })

  test("propagates a parent abort without a deadline error", async () => {
    const { track } = tracker()
    const parent = new AbortController()
    let attempts = 0
    const pending = fetchHosted(
      (_url, init) => {
        attempts += 1
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("caller cancelled")))
        })
      },
      "https://core.example/api/wr/events",
      INIT_GET,
      track,
      parent.signal,
      FAST_DEADLINE,
    )
    parent.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
    expect(attempts).toBe(1)
  })

  test("keeps the parent abort bound to a successful streaming response", async () => {
    const { track, active } = tracker()
    const parent = new AbortController()
    let streamSignal: AbortSignal | undefined
    const response = await fetchHosted(
      (_url, init) => {
        streamSignal = init.signal
        return Promise.resolve(new Response("data: x\n\n"))
      },
      "https://core.example/api/wr/events",
      INIT_GET,
      track,
      parent.signal,
      FAST_DEADLINE,
    )
    expect(response.ok).toBe(true)
    expect(active.size).toBe(0)
    expect(streamSignal?.aborted).toBe(false)
    parent.abort()
    // The winning attempt's signal must still follow the parent after
    // establishment, or logout could no longer end an open stream.
    expect(streamSignal?.aborted).toBe(true)
  })

  test("registers the attempt for logout-time abort while in flight", async () => {
    const { track, active } = tracker()
    let seenDuringFlight = -1
    const pending = fetchHosted(
      (_url, init) => {
        seenDuringFlight = active.size
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("socket destroyed")))
        })
      },
      "https://core.example/api/claxedo/bootstrap",
      INIT_GET,
      track,
      undefined,
      FAST_DEADLINE,
    )
    await expect(pending).rejects.toThrow()
    expect(seenDuringFlight).toBe(1)
    expect(active.size).toBe(0)
  })
})
