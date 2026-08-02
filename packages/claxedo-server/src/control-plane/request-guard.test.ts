/**
 * W3.2 default request guard behavior: the body cap, the IP-keyed rate limit,
 * the exemption registry, and the ordering between them.
 *
 * `route-guard-inventory.test.ts` asserts the guard reaches every mounted route;
 * this file asserts what it DOES when it gets there.
 */

import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import {
  DEFAULT_MAX_BODY_BYTES,
  defaultRequestGuard,
  requestClientKey,
  type RouteGuardExemption,
} from "./request-guard"
import { createFixedWindowConnectionRateLimiter, createLayeredRateLimiter } from "./rate-limit"

function guardedApp(options: Parameters<typeof defaultRequestGuard>[0] = {}) {
  const app = new Hono()
  app.use(defaultRequestGuard(options))
  app.post("/echo", async (c) => c.json({ length: (await c.req.text()).length }))
  app.get("/read", (c) => c.json({ ok: true }))
  app.post("/documents/doc_1", async (c) => c.json({ length: (await c.req.text()).length }))
  app.post("/documents-admin/purge", async (c) => c.json({ length: (await c.req.text()).length }))
  return app
}

function limiter(limit: number) {
  return createLayeredRateLimiter({
    local: createFixedWindowConnectionRateLimiter({ limit, windowMs: 60_000 }),
  })
}

const post = (app: Hono, path: string, body: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://cp.test${path}`, { method: "POST", body, headers }))

describe("W3.2 default body cap", () => {
  test("a body over the cap is rejected 413 with a structured error", async () => {
    const app = guardedApp({ maxBodyBytes: 1_024 })
    const response = await post(app, "/echo", "x".repeat(1_025))

    expect(response.status).toBe(413)
    // Structured like every other control-plane error, not hono's bare text
    // "Payload Too Large" — clients parse `error.code`.
    expect(await response.json()).toMatchObject({ error: { code: "request_body_too_large" } })
  })

  test("a body at exactly the cap is allowed (the boundary is inclusive)", async () => {
    const app = guardedApp({ maxBodyBytes: 1_024 })
    const response = await post(app, "/echo", "x".repeat(1_024))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ length: 1_024 })
  })

  test("a GET with no body passes untouched", async () => {
    const app = guardedApp({ maxBodyBytes: 1_024 })
    const response = await app.fetch(new Request("http://cp.test/read"))
    expect(response.status).toBe(200)
  })

  test("the default cap is 1 MiB", async () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024)
    const app = guardedApp()
    expect((await post(app, "/echo", "x".repeat(DEFAULT_MAX_BODY_BYTES + 1))).status).toBe(413)
    expect((await post(app, "/echo", "x".repeat(1_000))).status).toBe(200)
  })

  test("an exempted prefix skips the cap; a look-alike sibling does NOT", async () => {
    const exemptions: RouteGuardExemption[] = [
      { prefix: "/documents", bodyCap: true, reason: "own cap", enforcedBy: "documents.ts" },
    ]
    const app = guardedApp({ maxBodyBytes: 1_024, exemptions })

    expect((await post(app, "/documents/doc_1", "x".repeat(4_096))).status).toBe(200)
    // The segment-boundary property: `/documents-admin` must not inherit the
    // exemption just because it shares a string prefix.
    expect((await post(app, "/documents-admin/purge", "x".repeat(4_096))).status).toBe(413)
  })
})

describe("W3.2 default rate limit", () => {
  test("requests over the limit are rejected 429 with Retry-After", async () => {
    const app = guardedApp({ rateLimiter: limiter(2) })
    const send = () => app.fetch(new Request("http://cp.test/read", { headers: { "cf-connecting-ip": "198.51.100.9" } }))

    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)

    const rejected = await send()
    expect(rejected.status).toBe(429)
    // Retry-After in SECONDS per RFC 9110; a 0 would tell clients to retry now
    // and turn the limiter into a busy-loop invitation.
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await rejected.json()).toMatchObject({ error: { code: "rate_limited" } })
  })

  test("budgets are per-client — one flooder does not lock out everyone", async () => {
    // A shared bucket would make the limiter a trivially triggerable denial of
    // service on the entire control plane.
    const app = guardedApp({ rateLimiter: limiter(1) })
    const send = (ip: string) =>
      app.fetch(new Request("http://cp.test/read", { headers: { "cf-connecting-ip": ip } }))

    expect((await send("198.51.100.9")).status).toBe(200)
    expect((await send("198.51.100.9")).status).toBe(429)
    expect((await send("203.0.113.7")).status).toBe(200)
  })

  test("no rate limiter configured means no default limit (the cap still applies)", async () => {
    // Node/self-host and tests compose without one; the guard must not become a
    // hard dependency on a limiter existing.
    const app = guardedApp({ maxBodyBytes: 1_024 })
    for (let i = 0; i < 20; i += 1) {
      expect((await app.fetch(new Request("http://cp.test/read"))).status).toBe(200)
    }
    expect((await post(app, "/echo", "x".repeat(2_048))).status).toBe(413)
  })

  test("a rate-limit exemption does not exempt the body cap", async () => {
    const exemptions: RouteGuardExemption[] = [
      { prefix: "/echo", rateLimit: true, reason: "own limiter", enforcedBy: "somewhere.ts" },
    ]
    const app = guardedApp({ maxBodyBytes: 1_024, rateLimiter: limiter(1), exemptions })

    // Unlimited by the default limiter...
    for (let i = 0; i < 5; i += 1) {
      expect((await post(app, "/echo", "small")).status).toBe(200)
    }
    // ...but still capped. Exemptions are per-guard, so exempting one cannot
    // silently drop the other.
    expect((await post(app, "/echo", "x".repeat(2_048))).status).toBe(413)
  })

  test("the rate limit is checked BEFORE the body is read", async () => {
    // A rejected client should be turned away without the Worker buffering its
    // body — otherwise the expensive check is the one every flood pays for.
    const app = new Hono()
    app.use(defaultRequestGuard({ maxBodyBytes: 10_000, rateLimiter: limiter(1) }))
    const handler = vi.fn((c: { json: (value: unknown) => Response }) => c.json({ ok: true }))
    app.post("/echo", handler as never)

    const oversizedForNobody = "x".repeat(5_000)
    const send = () =>
      app.fetch(
        new Request("http://cp.test/echo", {
          method: "POST",
          body: oversizedForNobody,
          headers: { "cf-connecting-ip": "198.51.100.9" },
        }),
      )

    expect((await send()).status).toBe(200)
    const rejected = await send()
    // 429, not 413 or 200: the limiter answered first.
    expect(rejected.status).toBe(429)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("W3.2 client key derivation", () => {
  const keyFor = async (headers: Record<string, string>) => {
    let seen: string | undefined
    const app = new Hono()
    app.use(async (c, next) => {
      seen = requestClientKey(c)
      await next()
    })
    app.get("/", (c) => c.json({ ok: true }))
    await app.fetch(new Request("http://cp.test/", { headers }))
    return seen
  }

  test("prefers cf-connecting-ip, which a client cannot forge on the Worker path", async () => {
    // x-forwarded-for IS client-suppliable. If it won, an attacker would reach a
    // fresh bucket per request by varying the header — the limiter would be
    // decoration. Cloudflare sets cf-connecting-ip itself.
    await expect(keyFor({ "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "1.2.3.4" })).resolves.toBe(
      "198.51.100.9",
    )
  })

  test("falls back to the first x-forwarded-for entry for the Node container", async () => {
    await expect(keyFor({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" })).resolves.toBe("198.51.100.9")
  })

  test("an unidentifiable client shares one bucket rather than escaping the limit", async () => {
    // Fail CLOSED into a shared bucket. Returning a random key per request would
    // let anyone opt out of limiting by stripping headers.
    await expect(keyFor({})).resolves.toBe("anonymous")
  })
})
