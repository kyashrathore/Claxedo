import { describe, expect, test } from "bun:test"
import { onRequest } from "../functions/_middleware"
import { publicOrigin } from "../src/content/routes"

const next = () => Promise.resolve(new Response("ok", { status: 200 }))

describe("canonical host", () => {
  test("redirects www to the apex origin preserving path and query", async () => {
    const response = await onRequest({ request: new Request("https://www.claxedo.com/pricing?utm_source=test"), next })
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe(`${publicOrigin}/pricing?utm_source=test`)
  })

  test("redirects the www root in a single hop", async () => {
    const response = await onRequest({ request: new Request("https://www.claxedo.com/"), next })
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe(`${publicOrigin}/`)
  })

  test("passes apex, preview, and dev requests through to the site", async () => {
    for (const url of ["https://claxedo.com/", "https://main.claxedo-web.pages.dev/", "http://localhost:4321/"]) {
      const response = await onRequest({ request: new Request(url), next })
      expect(response.status).toBe(200)
    }
  })
})
