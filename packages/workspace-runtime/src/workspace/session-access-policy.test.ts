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

  test("applies the prefix policy before the opaque Session V2 proxy", async () => {
    const calls: Array<{ operation: string; method: string; path: string; sessionId?: string }> = []
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async () => ({ allowed: true }),
      filterSessions: async (input) => input.sessionIds,
      authorizePrefix: async (input) => {
        calls.push({
          operation: input.operation,
          method: input.method,
          path: input.path,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        })
        return { allowed: false, status: 403, code: "private_session", message: "denied" }
      },
    }
    const host = createWorkspaceHost({ sessionAccessPolicy: policy })
    const app = new Hono()
    host.mount(app, { exposure })

    const response = await app.request("http://localhost/api/session/ses_1/prompt", { method: "POST" })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "private_session", message: "denied" } })
    expect(calls).toEqual([{
      operation: "session_v2_proxy",
      method: "POST",
      path: "/api/session/ses_1/prompt",
      sessionId: "ses_1",
    }])
    host.dispose()
  })

  test("registers Session V2 creates and filters signed collection responses", async () => {
    const registered: string[] = []
    const filterCalls: string[][] = []
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async () => ({ allowed: true }),
      authorizePrefix: async () => ({ allowed: true }),
      filterSessions: async (input) => {
        filterCalls.push([...input.sessionIds])
        return input.sessionIds.filter((sessionId) => sessionId === "ses_visible")
      },
      registerSession: async (input) => {
        registered.push(input.sessionId)
        return { allowed: true }
      },
    }
    const host = createWorkspaceHost({
      sessionAccessPolicy: policy,
      opencodeCompat: true,
      opencodeRequest: async (request) => request.method === "POST"
        ? Response.json({ data: { id: "ses_created" } }, { status: 201 })
        : Response.json({
            data: [{ id: "ses_visible" }, { id: "ses_private" }],
            cursor: { next: "opaque" },
          }),
    })
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("relayHostAuth" as never, {
        workspace_id: "ws_1",
        org_id: "org_1",
        role: "editor",
        actor_id: "actor_1",
        actor_kind: "human",
      } as never)
      await next()
    })
    host.mount(app, { exposure })
    await host.apply({ version: 1, runner: { type: "opencode" }, auth: {}, mcp: {} })

    const created = await app.request("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-rht" },
      body: JSON.stringify({ title: "Managed" }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ data: { id: "ses_created" } })
    expect(registered).toEqual(["ses_created"])

    const listed = await app.request("http://localhost/api/session", {
      headers: { authorization: "Bearer signed-rht" },
    })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ data: [{ id: "ses_visible" }], cursor: { next: "opaque" } })
    expect(filterCalls).toEqual([["ses_visible", "ses_private"]])
    host.dispose()
  })
})
