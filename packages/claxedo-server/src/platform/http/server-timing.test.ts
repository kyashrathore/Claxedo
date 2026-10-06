import { describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { responseTiming, timed, timedD1 } from "./server-timing"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function slowDatabase(ms: number): D1Database {
  const statement = {
    bind: () => statement,
    first: async () => (await wait(ms), { ok: 1 }),
    all: async () => (await wait(ms), { results: [], success: true, meta: {} }),
    run: async () => (await wait(ms), { success: true, meta: {} }),
    raw: async () => (await wait(ms), []),
  }
  return { prepare: () => statement, batch: async (statements: unknown[]) => (await wait(ms), statements.map(() => ({ success: true, meta: {}, results: [] }))) } as unknown as D1Database
}

function timings(header: string | null) {
  return Object.fromEntries((header ?? "").split(", ").map((entry) => entry.split(";dur=")).map(([name, dur]) => [name, Number(dur)]))
}

describe("Server-Timing", () => {
  test("charges the request's database statements and Durable Object calls to its header, with the total around them", async () => {
    const database = timedD1(slowDatabase(20))
    const app = new Hono()
    app.use(responseTiming())
    app.get("/read", async (c) => {
      await database.prepare("select 1").bind(1).first()
      await database.batch([database.prepare("select 2"), database.prepare("select 3")])
      await timed("do", () => wait(30))
      return c.json({ ok: true })
    })
    const response = await app.request("https://core.test/read")
    const measured = timings(response.headers.get("server-timing"))
    expect(Object.keys(measured)).toEqual(["d1", "do", "total"])
    expect(measured.d1).toBeGreaterThanOrEqual(35)
    expect(measured.do).toBeGreaterThanOrEqual(25)
    expect(measured.total).toBeGreaterThanOrEqual(measured.d1 + measured.do - 5)
  })

  test("keeps concurrent requests' ledgers apart and runs an unrequested call untimed", async () => {
    const database = timedD1(slowDatabase(15))
    const app = new Hono()
    app.use(responseTiming())
    app.get("/one", async (c) => (await database.prepare("select 1").first(), c.text("one")))
    app.get("/three", async (c) => {
      for (const sql of ["select 1", "select 2", "select 3"]) await database.prepare(sql).first()
      return c.text("three")
    })
    const [one, three] = await Promise.all([app.request("https://core.test/one"), app.request("https://core.test/three")])
    expect(timings(one.headers.get("server-timing")).d1).toBeLessThan(40)
    expect(timings(three.headers.get("server-timing")).d1).toBeGreaterThanOrEqual(40)
    await expect(database.prepare("select 4").first()).resolves.toEqual({ ok: 1 })
  })
})
