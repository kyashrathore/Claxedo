import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import {
  ControlPlaneRouteContributionError,
  mountControlPlaneRouteContributions,
  type ControlPlaneRouteContribution,
} from "./route-contribution"

function contribution(id: string): ControlPlaneRouteContribution {
  return { id, path: `/api/${id}`, routes: new Hono().get("/", (c) => c.text(id)) }
}

describe("control-plane route contributions", () => {
  test("mounts nothing for a disabled product", async () => {
    const app = new Hono().get("/health", (c) => c.text("ok"))
    mountControlPlaneRouteContributions({
      contributions: [],
      mount: (item) => app.route(item.path, item.routes),
    })

    expect((await app.request("/health")).status).toBe(200)
    expect((await app.request("/api/agent-plugins")).status).toBe(404)
  })

  test("mounts an explicitly supplied family", async () => {
    const app = new Hono()
    mountControlPlaneRouteContributions({
      contributions: [contribution("agent-plugins")],
      mount: (item) => app.route(item.path, item.routes),
    })

    expect(await (await app.request("/api/agent-plugins")).text()).toBe("agent-plugins")
  })

  test("rejects duplicate contribution IDs before the second family can shadow", () => {
    const app = new Hono()
    expect(() => mountControlPlaneRouteContributions({
      contributions: [contribution("same"), contribution("same")],
      mount: (item) => app.route(item.path, item.routes),
    })).toThrowError(ControlPlaneRouteContributionError)
  })
})
