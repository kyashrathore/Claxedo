import { expect, test } from "vitest"
import { controlPlaneRoutePatterns } from "./public-origin"
import { releaseWorkerRoutes } from "./worker-routes"

/** The Cloudflare API as the deploy sees it: one zone, its Worker routes, and every call recorded. */
function cloudflare(routes: Array<{ id: string; pattern: string; script?: string }>) {
  const calls: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url)
    calls.push(`${init?.method ?? "GET"} ${pathname}${search}`)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token")
    if (pathname === "/client/v4/zones") {
      const name = new URL(url).searchParams.get("name")
      return Response.json({ success: true, result: name === "claxedo.dev" ? [{ id: "zone_1", name }] : [] })
    }
    if (pathname === "/client/v4/zones/zone_1/workers/routes") return Response.json({ success: true, result: routes })
    const deleted = /^\/client\/v4\/zones\/zone_1\/workers\/routes\/(.+)$/.exec(pathname)?.[1]
    if (init?.method === "DELETE" && deleted) {
      routes.splice(routes.findIndex((route) => route.id === deleted), 1)
      return Response.json({ success: true, result: { id: deleted } })
    }
    return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 })
  }
  return { fetch, calls, routes }
}

const patterns = controlPlaneRoutePatterns("app.claxedo.dev")

test("the control plane's routes the writer still holds are unassigned, and only those", async () => {
  const api = cloudflare([
    { id: "r_api", pattern: "app.claxedo.dev/api/*", script: "claxedo" },
    { id: "r_internal", pattern: "app.claxedo.dev/internal/*", script: "claxedo" },
    { id: "r_other", pattern: "app.claxedo.dev/legacy/*", script: "claxedo" },
    { id: "r_edge", pattern: "app.claxedo.dev/health*", script: "claxedo-edge" },
  ])
  const released = await releaseWorkerRoutes({ script: "claxedo", host: "app.claxedo.dev", patterns, token: "token", fetch: api.fetch })
  expect(released).toEqual(["app.claxedo.dev/api/*", "app.claxedo.dev/internal/*"])
  expect(api.routes.map((route) => route.id)).toEqual(["r_other", "r_edge"])
  expect(api.calls).toEqual([
    "GET /client/v4/zones?name=app.claxedo.dev",
    "GET /client/v4/zones?name=claxedo.dev",
    "GET /client/v4/zones/zone_1/workers/routes",
    "DELETE /client/v4/zones/zone_1/workers/routes/r_api",
    "DELETE /client/v4/zones/zone_1/workers/routes/r_internal",
  ])
})

test("once the routes have moved there is nothing to release, and an API refusal stops the deploy", async () => {
  const moved = cloudflare(patterns.map((pattern, index) => ({ id: `r_${index}`, pattern, script: "claxedo-edge" })))
  await expect(releaseWorkerRoutes({ script: "claxedo", host: "app.claxedo.dev", patterns, token: "token", fetch: moved.fetch })).resolves.toEqual([])
  expect(moved.calls.filter((call) => call.startsWith("DELETE"))).toEqual([])
  await expect(releaseWorkerRoutes({ script: "claxedo", host: "app.example.org", patterns, token: "token", fetch: moved.fetch })).rejects.toThrow(/no zone on this account holds app.example.org/)
})
