import { describe, expect, test } from "bun:test"
import { createKeyedSerializer, sleep, waitForHealth } from "./async"

describe("sleep", () => {
  test("sleep(0) is a macrotask yield, not a microtask resolve", async () => {
    const order: string[] = []
    // Queued BEFORE the sleep: a microtask-only resolve would jump ahead of it.
    setTimeout(() => order.push("timer"), 0)
    await sleep(0)
    order.push("sleep")
    expect(order).toEqual(["timer", "sleep"])
  })

  test("a negative delay still yields", async () => {
    const order: string[] = []
    setTimeout(() => order.push("timer"), 0)
    await sleep(-1)
    order.push("sleep")
    expect(order).toEqual(["timer", "sleep"])
  })

  test("waits at least the requested time", async () => {
    const started = Date.now()
    await sleep(25)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })
})

describe("createKeyedSerializer", () => {
  test("equal keys never overlap", async () => {
    const serializer = createKeyedSerializer()
    const order: string[] = []
    const task = (id: string) => async () => {
      order.push(`${id}:start`)
      await sleep(5)
      order.push(`${id}:end`)
      return id
    }
    const results = await Promise.all([
      serializer.run("k", task("a")),
      serializer.run("k", task("b")),
      serializer.run("k", task("c")),
    ])
    expect(results).toEqual(["a", "b", "c"])
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"])
  })

  test("the first operation on a key runs synchronously", () => {
    const serializer = createKeyedSerializer()
    let ran = false
    void serializer.run("k", async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test("different keys run concurrently", async () => {
    const serializer = createKeyedSerializer()
    const order: string[] = []
    await Promise.all([
      serializer.run("a", async () => {
        order.push("a:start")
        await sleep(10)
        order.push("a:end")
      }),
      serializer.run("b", async () => {
        order.push("b:start")
        await sleep(1)
        order.push("b:end")
      }),
    ])
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"])
  })

  test("a rejection neither blocks nor poisons its successors", async () => {
    const serializer = createKeyedSerializer()
    const boom = new Error("boom")
    const failed = serializer.run("k", () => Promise.reject(boom))
    const after = serializer.run("k", () => Promise.resolve("ok"))
    // The caller sees the ORIGINAL reason, by identity.
    await expect(failed).rejects.toBe(boom)
    expect(await after).toBe("ok")
  })

  test("a key is reusable after its queue drains", async () => {
    const serializer = createKeyedSerializer()
    expect(await serializer.run("k", async () => 1)).toBe(1)
    await sleep(0)
    expect(await serializer.run("k", async () => 2)).toBe(2)
  })

  test("clear drops the queues without cancelling in-flight work", async () => {
    const serializer = createKeyedSerializer()
    const inFlight = serializer.run("k", async () => {
      await sleep(5)
      return "done"
    })
    serializer.clear()
    expect(await inFlight).toBe("done")
  })
})

describe("waitForHealth", () => {
  test("retries past non-ok responses and returns true once one is ok", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return new Response("", { status: hits < 3 ? 503 : 200 })
      },
    })
    try {
      expect(await waitForHealth(server.url.toString(), { timeoutMs: 5_000, intervalMs: 5 })).toBe(
        true,
      )
      expect(hits).toBe(3)
    } finally {
      await server.stop(true)
    }
  })

  test("a connection refused is swallowed and the deadline returns false", async () => {
    const started = Date.now()
    // Port 1 on loopback is not bindable by an unprivileged process, so this
    // is a refused connection rather than a hang.
    expect(
      await waitForHealth("http://127.0.0.1:1/health", { timeoutMs: 120, intervalMs: 10 }),
    ).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })
})
