import { describe, expect, test } from "bun:test"

import { embeddedServerReadiness } from "./server-readiness"

// The guarantee under test is the one `prepare()` must not weaken: a server that
// is LISTENING BUT BROKEN is still detected. `main/index.ts` turns a rejection
// here into killing the child and rejecting `serverReady`, so every rejection
// path below is a user-visible startup error rather than a shell wired to a
// dead server.

type Call = { url: string; aborted: boolean }

function recorder(responses: (() => Promise<{ ok: boolean; status: number }>)[]) {
  const calls: Call[] = []
  let index = 0
  return {
    calls,
    fetch: async (url: string, init: { signal: AbortSignal }) => {
      calls.push({ url, aborted: init.signal.aborted })
      const next = responses[Math.min(index, responses.length - 1)]
      index++
      if (!next) throw new Error("no response configured")
      return await next()
    },
  }
}

const ok = () => Promise.resolve({ ok: true, status: 200 })
const status = (code: number) => () => Promise.resolve({ ok: false, status: code })
const refused = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:65202"))

describe("embedded server readiness", () => {
  test("verify resolves when the server answers", async () => {
    const spy = recorder([ok])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    await readiness.verify()

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].url).toBe("http://127.0.0.1:65202/api/claxedo/health")
  })

  test("verify rejects, naming the status, when a listening server answers badly", async () => {
    const spy = recorder([status(503)])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    await expect(readiness.verify()).rejects.toThrow("health check returned 503")
  })

  test("verify rejects when a listening server does not answer at all", async () => {
    const spy = recorder([refused])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    await expect(readiness.verify()).rejects.toThrow("ECONNREFUSED")
  })

  test("prepare hits the same URL verify does, so the two can never drift apart", () => {
    const spy = recorder([refused])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    readiness.prepare()

    expect(spy.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:65202/api/claxedo/health"])
  })

  test("a prepare that fails is swallowed and leaves verify's outcome untouched", async () => {
    const spy = recorder([refused, ok])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    expect(() => readiness.prepare()).not.toThrow()
    await readiness.verify()

    expect(spy.calls).toHaveLength(2)
  })

  test("a prepare that succeeds does NOT stand in for the check", async () => {
    // The whole point: prepare pays a cost, it does not answer a question. A
    // broken server that happened to answer the preparation must still be
    // caught by the verification that follows. Settled deliberately before
    // verifying, so a cache written by prepare's own callback has every chance
    // to be observed rather than being missed on microtask ordering.
    const spy = recorder([ok, status(500)])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    readiness.prepare()
    await Bun.sleep(5)

    await expect(readiness.verify()).rejects.toThrow("health check returned 500")
    expect(spy.calls).toHaveLength(2)
  })

  test("prepare cannot block: a request that never settles still leaves verify free to run", async () => {
    const pending = () => new Promise<{ ok: boolean; status: number }>(() => undefined)
    const spy = recorder([pending, ok])
    const readiness = embeddedServerReadiness({ healthUrl: "http://127.0.0.1:65202/api/claxedo/health", fetch: spy.fetch })

    readiness.prepare()

    await readiness.verify()
    expect(spy.calls).toHaveLength(2)
  })

  test("prepare survives a client that throws synchronously", () => {
    const readiness = embeddedServerReadiness({
      healthUrl: "http://127.0.0.1:65202/api/claxedo/health",
      fetch: () => {
        throw new Error("client unavailable")
      },
    })

    expect(() => readiness.prepare()).not.toThrow()
  })

  test("both requests carry a bounded signal, so neither can hang startup", async () => {
    const spy = recorder([ok, ok])
    const readiness = embeddedServerReadiness({
      healthUrl: "http://127.0.0.1:65202/api/claxedo/health",
      timeoutMs: 5,
      fetch: spy.fetch,
    })

    readiness.prepare()
    await readiness.verify()

    expect(spy.calls).toHaveLength(2)
    for (const call of spy.calls) expect(call.aborted).toBe(false)
    await Bun.sleep(20)
  })
})
