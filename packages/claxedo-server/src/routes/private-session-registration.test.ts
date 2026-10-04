import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { PrivateSessionRegistrationRoutes } from "./private-session-registration"
import { testRequestAuthenticationAdapter } from "../test-support/request-authentication"

type ReserveSession = (
  auth: { user: { subject: string; issuer: string } },
  input: Record<string, unknown>,
) => Promise<any>

function app(reserveSession: ReserveSession, defaultHarnessId?: (userId: string) => Promise<string | undefined>) {
  return new Hono().route(
    "/api/control/session-registrations",
    PrivateSessionRegistrationRoutes({
      authentication: testRequestAuthenticationAdapter(),
      authority: { reserveSession },
      ...(defaultHarnessId ? { defaultHarnessId } : {}),
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

  test("places the session by the harness it names, or by its creator's default when it names none", async () => {
    const reserveSession = vi.fn<ReserveSession>(async (_auth, input) => ({ changed: true, ...input, state: "reserved" }))
    const defaults = vi.fn(async () => "pi")
    const target = app(reserveSession, defaults)
    const intent = { operationId: "op_1", sessionId: "ses_1", workspaceId: "ws_1", kind: "create" }
    expect((await reserve(target, { ...intent, harness: { id: "codex", access: "native" } })).status).toBe(201)
    expect((await reserve(target, { ...intent, operationId: "op_2", sessionId: "ses_2", harness: { id: "conn_1", access: "connection" } })).status).toBe(201)
    expect((await reserve(target, { ...intent, operationId: "op_3", sessionId: "ses_3" })).status).toBe(201)
    expect(reserveSession.mock.calls.map(([, input]) => input.harnessId)).toEqual(["codex", "connection", "pi"])
    expect(defaults).toHaveBeenCalledOnce()
    expect((await reserve(target, { ...intent, operationId: "op_4", sessionId: "ses_4", harness: { id: "pi" } })).status).toBe(400)
  })
})
