import { describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { Hono } from "hono"
import { mark, timed, timedAuthentication, timedD1, timedFetch, timedResponse } from "./server-timing"

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
  const entries = (header ?? "").split(", ")
  const durations = entries.filter((entry) => entry.includes(";dur=") && !entry.includes(";desc="))
  const hosts = entries.filter((entry) => entry.includes(";desc="))
  return {
    marks: entries.filter((entry) => !entry.includes(";")),
    durations: Object.fromEntries(durations.map((entry) => entry.split(";dur=")).map(([name, dur]) => [name, Number(dur)])),
    hosts: Object.fromEntries(hosts.map((entry) => /^upstream-host;desc="([^"]+)";dur=(.+)$/.exec(entry)!).map(([, host, dur]) => [host, Number(dur)])),
  }
}

function served(app: Hono, url: string) {
  const request = new Request(url)
  return timedResponse(request, async () => app.fetch(request))
}

describe("Server-Timing", () => {
  test("charges the request's verification, database statements and Durable Object calls to its header, with the total around them", async () => {
    const database = timedD1(slowDatabase(20))
    const authentication = timedAuthentication({
      descriptor: { adapter: "better-auth" },
      authenticate: async () => (await database.prepare("select session").first(), { userId: "usr_1" }),
    } as unknown as RequestAuthenticationAdapter)
    const app = new Hono()
    app.get("/read", async (c) => {
      await authentication.authenticate(c.req.raw)
      await database.batch([database.prepare("select 2"), database.prepare("select 3")])
      await timed("do", () => wait(30))
      return c.json({ ok: true })
    })
    const measured = timings((await served(app, "https://core.test/read")).headers.get("server-timing"))
    expect(measured.marks, "the first request this module serves is the isolate's cold one").toEqual(["cold"])
    expect(Object.keys(measured.durations)).toEqual(["auth", "limit", "d1", "do", "upstream", "total"])
    expect(measured.durations.auth).toBeGreaterThanOrEqual(15)
    expect(measured.durations.d1).toBeGreaterThanOrEqual(35)
    expect(measured.durations.do).toBeGreaterThanOrEqual(25)
    expect(measured.durations.total).toBeGreaterThanOrEqual(measured.durations.d1 + measured.durations.do - 5)
  })

  test("names a request that composed the plane, and marks a later request with nothing", async () => {
    const app = new Hono()
    app.get("/composed", (c) => (mark("compose"), c.text("built")))
    app.get("/plain", (c) => c.text("reused"))
    const composed = timings((await served(app, "https://core.test/composed")).headers.get("server-timing"))
    const plain = timings((await served(app, "https://core.test/plain")).headers.get("server-timing"))
    expect(composed.marks).toEqual(["compose"])
    expect(plain.marks).toEqual([])
  })

  test("charges concurrent statements their shared wall time once, so the database never reads longer than the request", async () => {
    const database = timedD1(slowDatabase(30))
    const app = new Hono()
    app.get("/parallel", async (c) => {
      await Promise.all([database.prepare("select 1").first(), database.prepare("select 2").first(), database.prepare("select 3").first()])
      return c.text("parallel")
    })
    const measured = timings((await served(app, "https://core.test/parallel")).headers.get("server-timing")).durations
    expect(measured.d1).toBeGreaterThanOrEqual(25)
    expect(measured.d1).toBeLessThanOrEqual(measured.total)
  })

  test("keeps concurrent requests' ledgers apart and runs an unrequested call untimed", async () => {
    const database = timedD1(slowDatabase(15))
    const app = new Hono()
    app.get("/one", async (c) => (await database.prepare("select 1").first(), c.text("one")))
    app.get("/three", async (c) => {
      for (const sql of ["select 1", "select 2", "select 3"]) await database.prepare(sql).first()
      return c.text("three")
    })
    const [one, three] = await Promise.all([served(app, "https://core.test/one"), served(app, "https://core.test/three")])
    expect(timings(one.headers.get("server-timing")).durations.d1).toBeLessThan(40)
    expect(timings(three.headers.get("server-timing")).durations.d1).toBeGreaterThanOrEqual(40)
    await expect(database.prepare("select 4").first()).resolves.toEqual({ ok: 1 })
  })

  test("charges outbound requests to upstream once however many overlap, and to each host they went to", async () => {
    const vendor = timedFetch(async (input) => {
      await wait(new URL(input instanceof Request ? input.url : input).host === "api.github.com" ? 40 : 20)
      return new Response("ok")
    })
    const app = new Hono()
    app.get("/callback", async (c) => {
      await vendor("https://github.com/login/oauth/access_token", { method: "POST" })
      await Promise.all([vendor("https://api.github.com/user"), vendor("https://api.github.com/user/emails")])
      return c.text("signed in")
    })
    const measured = timings((await served(app, "https://core.test/callback")).headers.get("server-timing"))
    expect(Object.keys(measured.hosts)).toEqual(["github.com", "api.github.com"])
    expect(measured.hosts["github.com"]).toBeGreaterThanOrEqual(15)
    expect(measured.hosts["api.github.com"]).toBeGreaterThanOrEqual(35)
    expect(measured.hosts["api.github.com"], "the two reads overlap, so their host is charged their shared time once").toBeLessThan(70)
    expect(measured.durations.upstream).toBeGreaterThanOrEqual(50)
    expect(measured.durations.upstream).toBeLessThanOrEqual(measured.durations.total)
    await expect(vendor("https://api.github.com/user").then((response) => response.text()), "outside a request it only sends").resolves.toBe("ok")
  })
})

describe("Server-Timing names the D1 instances that answered", () => {
  test("each region once, primary or replica as D1 reports it, from single and batched results", async () => {
    const answer = (meta: Record<string, unknown>) => ({ success: true, results: [], meta })
    const statement = {
      bind: () => statement,
      all: async () => answer({ served_by_region: "APAC", served_by_primary: false }),
      run: async () => answer({ served_by_region: "ENAM", served_by_primary: true }),
      first: async () => ({ ok: 1 }),
    }
    const database = timedD1({
      prepare: () => statement,
      batch: async () => [answer({ served_by_region: "APAC", served_by_primary: false }), answer({})],
    } as unknown as D1Database)
    const app = new Hono()
    app.get("/mixed", async (c) => {
      await database.prepare("select 1").all()
      await database.batch([database.prepare("select 2"), database.prepare("select 3")])
      await database.prepare("insert").run()
      await database.prepare("select 4").first()
      return c.json({ ok: true })
    })
    app.get("/local", async (c) => {
      await database.prepare("select 4").first()
      return c.json({ ok: true })
    })
    const header = (await served(app, "https://core.test/mixed")).headers.get("server-timing") ?? ""
    expect(header.split(", ").filter((entry) => entry.startsWith("d1-served"))).toEqual(['d1-served;desc="APAC-replica"', 'd1-served;desc="ENAM-primary"'])
    expect((await served(app, "https://core.test/local")).headers.get("server-timing")).not.toContain("d1-served")
  })
})
