import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { embeddedWorkspaceRuntimeExposure, privateNetworkWorkspaceRuntimeExposure } from "../exposure"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { createWorkspaceHost } from "./runtime"

const exposure = privateNetworkWorkspaceRuntimeExposure({ name: "test", guard: () => true, runtimeAuth: () => true })

describe("managed workspace SessionAccessPolicy composition", () => {
  test("refuses to mount managed session routes without a policy", () => {
    const host = createWorkspaceHost()
    expect(() => host.mount(new Hono(), { exposure })).toThrow("Managed workspace session routes require SessionAccessPolicy")
    host.dispose()
  })

  test("refuses to mount a workspace-role-only policy on a managed host", () => {
    const host = createWorkspaceHost({ sessionAccessPolicy: managedWorkspaceSessionAccessPolicy() })
    expect(() => host.mount(new Hono(), { exposure })).toThrow(
      "Managed workspace session routes require authority-backed SessionAccessPolicy",
    )
    host.dispose()
  })

  test("keeps caller-owned embedded composition in explicit local scope", () => {
    const host = createWorkspaceHost({ sessionAccessPolicy: managedWorkspaceSessionAccessPolicy() })
    expect(() => host.mount(new Hono(), {
      exposure: embeddedWorkspaceRuntimeExposure({ owner: "test", guard: () => true }),
    })).not.toThrow()
    host.dispose()
  })

  test("the removed raw Session V2 transport has no reachable routes", async () => {
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async () => ({ allowed: true }),
      authorizePrefix: async () => ({ allowed: true }),
      filterSessions: async (input) => input.sessionIds,
    }
    const host = createWorkspaceHost({ sessionAccessPolicy: policy })
    const app = new Hono()
    host.mount(app, { exposure })
    try {
      for (const [url, method] of [
        ["/api/session", "GET"],
        ["/api/session", "POST"],
        ["/api/session/ses_private/prompt", "POST"],
      ]) {
        expect((await app.request("http://localhost" + url, { method })).status).toBe(404)
      }
    } finally { host.dispose() }
  })
})
