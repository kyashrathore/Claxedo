import { describe, expect, test } from "bun:test"
import { fetchHostedWithStallRecovery } from "./hosted-transport"

const INIT_GET = { method: "GET", headers: { authorization: "Bearer t" } }
const INIT_POST = { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" }
const FAST = { stallMs: 40, retryStallMs: 60 }

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

describe("fetchHostedWithStallRecovery", () => {
  test("retries a stalled GET once on a fresh connection", async () => {
    const { track } = tracker()
    const attempts: Array<{ aborted: boolean }> = []
    const response = await fetchHostedWithStallRecovery(
      (_url, init) => {
        const attempt = { aborted: false }
        attempts.push(attempt)
        if (attempts.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              attempt.aborted = true
              reject(new Error("socket destroyed"))
            })
          })
        }
        return Promise.resolve(Response.json({ ok: true }))
      },
      "https://core.example/api/claxedo/bootstrap",
      INIT_GET,
      track,
      undefined,
      FAST,
    )
    expect(await response.json()).toEqual({ ok: true })
    expect(attempts.length).toBe(2)
    // The stalled socket must be destroyed before the retry begins.
    expect(attempts[0]!.aborted).toBe(true)
  })

  test("never retries a mutation", async () => {
    const { track } = tracker()
    let attempts = 0
    await expect(
      fetchHostedWithStallRecovery(
        () => {
          attempts += 1
          return Promise.reject(new Error("connection reset"))
        },
        "https://core.example/api/workspace/create",
        INIT_POST,
        track,
      ),
    ).rejects.toThrow("connection reset")
    expect(attempts).toBe(1)
  })

  test("propagates a parent abort without retrying", async () => {
    const { track } = tracker()
    const parent = new AbortController()
    let attempts = 0
    const pending = fetchHostedWithStallRecovery(
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
      FAST,
    )
    parent.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
    expect(attempts).toBe(1)
  })

  test("keeps the parent abort bound to a successful streaming response", async () => {
    const { track, active } = tracker()
    const parent = new AbortController()
    let streamSignal: AbortSignal | undefined
    const response = await fetchHostedWithStallRecovery(
      (_url, init) => {
        streamSignal = init.signal
        return Promise.resolve(new Response("data: x\n\n"))
      },
      "https://core.example/api/wr/events",
      INIT_GET,
      track,
      parent.signal,
      FAST,
    )
    expect(response.ok).toBe(true)
    expect(active.size).toBe(0)
    expect(streamSignal?.aborted).toBe(false)
    parent.abort()
    // The winning attempt's signal must still follow the parent after
    // establishment, or logout could no longer end an open stream.
    expect(streamSignal?.aborted).toBe(true)
  })

  test("registers every attempt for logout-time abort while in flight", async () => {
    const { track, active } = tracker()
    let seen = 0
    const pending = fetchHostedWithStallRecovery(
      (_url, init) => {
        seen += 1
        expect(active.size).toBe(1)
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("socket destroyed")))
        })
      },
      "https://core.example/api/claxedo/bootstrap",
      INIT_GET,
      track,
      undefined,
      FAST,
    )
    await expect(pending).rejects.toThrow()
    expect(seen).toBe(2)
    expect(active.size).toBe(0)
  })
})
