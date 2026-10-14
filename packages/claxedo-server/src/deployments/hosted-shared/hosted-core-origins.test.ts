import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { configuredCoreAppOrigins, coreAppHomeOrigin, corsMiddleware } from "./hosted-core-origins"

describe("coreAppHomeOrigin", () => {
  test("takes the first exact origin", () => {
    expect(coreAppHomeOrigin("https://a.test,https://b.test")).toBe("https://a.test")
  })

  /** A wildcard names a SHAPE, not a destination — redirecting to one emits a literal asterisk. */
  test("skips wildcard entries", () => {
    expect(coreAppHomeOrigin("https://*.example.test,https://real.test")).toBe("https://real.test")
    expect(coreAppHomeOrigin("https://*.example.test")).toBeUndefined()
  })

  test("is absent when nothing is configured", () => {
    expect(coreAppHomeOrigin(undefined)).toBeUndefined()
    expect(coreAppHomeOrigin("")).toBeUndefined()
  })
})

describe("corsMiddleware", () => {
  const app = new Hono()
  app.use(corsMiddleware(configuredCoreAppOrigins("https://app.test,https://*.preview.test"), []))
  app.all("*", (c) => c.text("ok"))
  const allowed = async (path: string, origin: string) =>
    (await app.request(`https://core.test${path}`, { headers: { origin } })).headers.get("access-control-allow-origin")

  test("stamps an admitted app origin, exact or under a wildcard suffix, and no other", async () => {
    expect(await allowed("/api/claxedo/health", "https://app.test")).toBe("https://app.test")
    expect(await allowed("/api/claxedo/health", "https://pr-7.preview.test")).toBe("https://pr-7.preview.test")
    expect(await allowed("/api/claxedo/health", "https://evil.test")).toBeNull()
  })

  test("grants no browser origin the credential broker", async () => {
    expect(await allowed("/bindings/abc/v1/messages", "https://app.test")).toBeNull()
  })
})
