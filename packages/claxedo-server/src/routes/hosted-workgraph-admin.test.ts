import { describe, expect, test, vi } from "vitest"
import { createFixedWindowConnectionRateLimiter } from "../control-plane/rate-limit"
import { HostedWorkGraphAdminRoutes } from "./hosted-workgraph-admin"

describe("hosted WorkGraph reconciliation admin route", () => {
  test("fails closed for missing, wrong, and unconfigured admin tokens", async () => {
    const reconcile = vi.fn(async () => result())
    const app = HostedWorkGraphAdminRoutes({ adminToken: "admin_secret", reconcile })
    expect((await app.request("/internal/workgraph/reconcile", { method: "POST" })).status).toBe(401)
    expect(
      (await app.request("/internal/workgraph/reconcile", { method: "POST", headers: auth("wrong") })).status,
    ).toBe(401)
    expect(
      (
        await HostedWorkGraphAdminRoutes({ reconcile }).request("/internal/workgraph/reconcile", {
          method: "POST",
          headers: auth("anything"),
        })
      ).status,
    ).toBe(401)
    expect(reconcile).not.toHaveBeenCalled()
  })

  test("runs the same bounded reconciler without an owner selector and returns content-free counts", async () => {
    const reconcile = vi.fn(async () => result())
    const telemetry = { capture: vi.fn() }
    const response = await HostedWorkGraphAdminRoutes({ adminToken: "admin_secret", reconcile, telemetry }).request(
      "/internal/workgraph/reconcile",
      { method: "POST", headers: auth("admin_secret") },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: {
        launched: 1,
        results: 1,
        controls: 1,
        intake: 0,
        sourcePlansLaunched: 1,
        sourcePlanResults: 1,
      },
    })
    expect(reconcile).toHaveBeenCalledWith()
    expect(telemetry.capture).toHaveBeenCalledWith(
      "system",
      "workgraph.reconcile",
      expect.objectContaining({ launched: 1 }),
    )
  })

  test("rejects owner selectors instead of allowing privileged cross-owner targeting", async () => {
    const reconcile = vi.fn(async () => result())
    const app = HostedWorkGraphAdminRoutes({ adminToken: "admin_secret", reconcile })
    expect(
      (
        await app.request("/internal/workgraph/reconcile?ownerUserId=another_user", {
          method: "POST",
          headers: auth("admin_secret"),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await app.request("/internal/workgraph/reconcile", {
          method: "POST",
          headers: { ...auth("admin_secret"), "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "another_workspace" }),
        })
      ).status,
    ).toBe(400)
    expect(reconcile).not.toHaveBeenCalled()
  })

  test("rate limits repeated machine requests and reports an unconfigured reconciler", async () => {
    const reconcile = vi.fn(async () => result())
    const app = HostedWorkGraphAdminRoutes({
      adminToken: "admin_secret",
      reconcile,
      rateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
    })
    expect(
      (await app.request("/internal/workgraph/reconcile", { method: "POST", headers: auth("admin_secret") })).status,
    ).toBe(200)
    const limited = await app.request("/internal/workgraph/reconcile", {
      method: "POST",
      headers: auth("admin_secret"),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(reconcile).toHaveBeenCalledTimes(1)

    const unavailable = await HostedWorkGraphAdminRoutes({ adminToken: "admin_secret" }).request(
      "/internal/workgraph/reconcile",
      { method: "POST", headers: auth("admin_secret") },
    )
    expect(unavailable.status).toBe(501)
  })
})

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

function result() {
  return {
    launched: [{}],
    results: [{}],
    background: {
      controls: [{}],
      intake: { completed: 0 },
      sourcePlanning: { launched: [{}], results: [{}] },
    },
  }
}
