import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { embeddedWorkspaceRuntimeExposure, privateNetworkWorkspaceRuntimeExposure } from "../exposure"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { createWorkspaceHost } from "./runtime"

const exposure = privateNetworkWorkspaceRuntimeExposure({ name: "test", guard: () => true, runtimeAuth: () => true })

describe("managed workspace SessionAccessPolicy composition", () => {
  test("refuses to mount managed session routes without a policy", async () => {
    const host = createWorkspaceHost()
    expect(() => host.mount(new Hono(), { exposure })).toThrow("Managed workspace session routes require SessionAccessPolicy")
    await host.dispose()
  })

  test("refuses to mount a workspace-role-only policy on a managed host", async () => {
    const host = createWorkspaceHost({ sessionAccessPolicy: managedWorkspaceSessionAccessPolicy() })
    expect(() => host.mount(new Hono(), { exposure })).toThrow(
      "Managed workspace session routes require authority-backed SessionAccessPolicy",
    )
    await host.dispose()
  })

  test("keeps caller-owned embedded composition in explicit local scope", async () => {
    const host = createWorkspaceHost({ sessionAccessPolicy: managedWorkspaceSessionAccessPolicy() })
    expect(() => host.mount(new Hono(), {
      exposure: embeddedWorkspaceRuntimeExposure({ owner: "test", guard: () => true }),
    })).not.toThrow()
    await host.dispose()
  })

  test("does not expose removed OpenCode Session V2 proxy routes", async () => {
    const host = createWorkspaceHost({ sessionAccessPolicy: managedWorkspaceSessionAccessPolicy() })
    const app = new Hono()
    host.mount(app, { exposure: embeddedWorkspaceRuntimeExposure({ owner: "test", guard: () => true }) })
    for (const pathname of ["/api/session", "/api/session/ses_1/prompt", "/api/model"]) {
      expect((await app.request("http://localhost" + pathname)).status).toBe(404)
      expect((await app.request("http://localhost" + pathname, { method: "POST" })).status).toBe(404)
    }
    await host.dispose()
  })
})
