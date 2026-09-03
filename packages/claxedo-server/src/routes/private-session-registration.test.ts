import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { PrivateSessionRegistrationRoutes } from "./private-session-registration"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"

type ReserveSession = (
  auth: { user: { subject: string; issuer: string } },
  input: Record<string, unknown>,
) => Promise<any>

function app(reserveSession: ReserveSession) {
  return new Hono().route(
    "/api/control/session-registrations",
    PrivateSessionRegistrationRoutes({
      authentication: testRequestAuthenticationAdapter(),
      authority: { reserveSession },
    }),
  )
}

function reserve(target: Hono, body: Record<string, unknown>, authenticated = true) {
  return target.request("/api/control/session-registrations/reserve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer user_1" } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("private session reservation routes", () => {
  test("reserves an immutable create intent under canonical signed auth", async () => {
    const reserveSession = vi.fn<ReserveSession>(async () => ({
      changed: true,
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      state: "reserved",
    }))
    const response = await reserve(app(reserveSession), {
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "create",
      title: "Private",
      actorId: "forged",
    })

    expect(response.status).toBe(201)
    expect(reserveSession).toHaveBeenCalledOnce()
    expect(reserveSession.mock.calls[0]?.[0]).toMatchObject({
      user: { subject: "user_1", issuer: "https://auth.test" },
    })
    expect(reserveSession.mock.calls[0]?.[1]).toEqual({
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "create",
      title: "Private",
    })
  })

  test("returns 200 for the same idempotent reservation", async () => {
    const response = await reserve(app(async () => ({
      changed: false,
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      state: "reserved",
    })), {
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "create",
    })
    expect(response.status).toBe(200)
  })

  test("requires signed auth and validates create/fork shape before authority", async () => {
    const reserveSession = vi.fn<ReserveSession>(async () => ({}))
    expect((await reserve(app(reserveSession), {
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "create",
    }, false)).status).toBe(401)
    expect((await reserve(app(reserveSession), {
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "fork",
    })).status).toBe(400)
    expect((await reserve(app(reserveSession), {
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      kind: "create",
      parentSessionId: "ses_parent",
    })).status).toBe(400)
    expect(reserveSession).not.toHaveBeenCalled()
  })

  test("preserves typed conflict and authorization denials", async () => {
    for (const [code, status] of [
      ["resource_conflict", 409],
      ["actor_authorization_denied", 403],
    ] as const) {
      const error = Object.assign(new Error(code), { code })
      const response = await reserve(app(async () => { throw error }), {
        operationId: "op_1",
        sessionId: "ses_1",
        workspaceId: "ws_1",
        kind: "create",
      })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: { code, message: code } })
    }
  })
})
