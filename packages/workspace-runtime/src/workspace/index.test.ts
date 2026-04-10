import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  createWorkspaceFullHost,
  createWorkspaceMinimalHost,
  mountWorkspaceCore,
} from "./index"

function paths(app: Hono) {
  return ((app as { routes?: Array<{ path: string }> }).routes ?? []).map((route) => route.path)
}

function has(paths: string[], prefix: string) {
  return paths.some((path) => path === prefix || path.startsWith(prefix + "/"))
}

describe("workspace module wiring", () => {
  test("mountWorkspaceCore registers the workspace routes", async () => {
    const app = new Hono()
    mountWorkspaceCore(app, (() => () => ({})) as never, "full")

    const seen = paths(app)
    expect(seen).toContain("/api/wr/capabilities")
    expect(has(seen, "/api/claxedo/pty")).toBe(true)
    expect(has(seen, "/api/claxedo/hook")).toBe(true)
    expect(has(seen, "/api/claxedo/events")).toBe(true)
    expect(has(seen, "/api/claxedo/process")).toBe(true)
    expect(has(seen, "/api/claxedo/diff")).toBe(true)

    const res = await app.request("http://localhost/api/wr/capabilities")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      profile: "full",
      session_host: true,
      runner_host: true,
    })
  })

  test("full and minimal hosts mount their profile routes", async () => {
    const full = createWorkspaceFullHost()
    const fullApp = new Hono()
    full.mount(fullApp)

    const fullPaths = paths(fullApp)
    expect(fullPaths).toContain("/api/wr/acp-config-options")
    expect(fullPaths).toContain("/global/event")
    expect(fullPaths).toContain("/session/status")

    const fullRes = await fullApp.request("http://localhost/api/wr/acp-config-options")
    expect(fullRes.status).toBe(200)
    expect(await fullRes.json()).toEqual([])

    const minimal = createWorkspaceMinimalHost()
    const minimalApp = new Hono()
    minimal.mount(minimalApp)

    const minimalPaths = paths(minimalApp)
    expect(minimalPaths).toContain("/api/wr/acp-config-options")
    expect(minimalPaths).toContain("/global/event")

    const minimalRes = await minimalApp.request("http://localhost/api/wr/acp-config-options")
    expect(minimalRes.status).toBe(200)
    expect(await minimalRes.json()).toEqual([])
  })
})
