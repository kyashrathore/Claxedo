import { describe, expect, test } from "vitest"
import { forkSessionWithReservation, reservePrivateSession } from "./private-session-reservation"

describe("private session reservation", () => {
  test("reserves a preassigned create intent on the authenticated control plane", async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const reservation = await reservePrivateSession({
      serverUrl: "https://core.test",
      workspaceId: "ws_1",
      kind: "create",
      title: "Private",
      sessionId: "ses_fixed",
      operationId: "op_fixed",
      request: async (request, init) => {
        requests.push({ url: String(request), body: JSON.parse(String(init?.body)) })
        return Response.json({
          changed: true,
          operationId: "op_fixed",
          sessionId: "ses_fixed",
          workspaceId: "ws_1",
          state: "reserved",
        }, { status: 201 })
      },
    })
    expect(reservation).toEqual({ operationId: "op_fixed", sessionId: "ses_fixed", workspaceId: "ws_1" })
    expect(requests).toEqual([{
      url: "https://core.test/api/control/session-registrations/reserve",
      body: {
        operationId: "op_fixed",
        sessionId: "ses_fixed",
        workspaceId: "ws_1",
        kind: "create",
        title: "Private",
      },
    }])
  })

  test("rejects a mismatched reservation response and preserves typed denial messages", async () => {
    await expect(reservePrivateSession({
      serverUrl: "https://core.test",
      workspaceId: "ws_1",
      kind: "create",
      sessionId: "ses_fixed",
      operationId: "op_fixed",
      request: async () => Response.json({
        operationId: "op_other",
        sessionId: "ses_fixed",
        workspaceId: "ws_1",
        state: "reserved",
      }),
    })).rejects.toThrow("immutable intent")
    await expect(reservePrivateSession({
      serverUrl: "https://core.test",
      workspaceId: "ws_1",
      kind: "create",
      sessionId: "ses_fixed",
      operationId: "op_fixed",
      request: async () => Response.json({ error: { message: "Workspace editor authority is required" } }, { status: 403 }),
    })).rejects.toThrow("Workspace editor authority is required")
  })

  test("reserves a fork and forwards the exact child id and operation to the runtime", async () => {
    const runtime: unknown[] = []
    const result = await forkSessionWithReservation({
      managed: true,
      workspaceId: "ws_1",
      sessionId: "ses_parent",
      messageId: "msg_1",
      serverUrl: "https://core.test",
      request: async (_request, init) => {
        const body = JSON.parse(String(init?.body)) as {
          operationId: string
          sessionId: string
          workspaceId: string
        }
        expect(body).toMatchObject({
          workspaceId: "ws_1",
          kind: "fork",
          parentSessionId: "ses_parent",
        })
        return Response.json({ ...body, changed: true, state: "reserved" }, { status: 201 })
      },
      client: {
        fork: async (input, options) => {
          runtime.push({ input, options })
          return { data: { id: input.id! } }
        },
      },
    })
    expect(result.data?.id).toMatch(/^ses_/)
    expect(runtime).toEqual([{
      input: {
        sessionID: "ses_parent",
        id: result.data?.id,
        messageID: "msg_1",
      },
      options: {
        headers: {
          "x-claxedo-session-registration-operation": expect.stringMatching(/^session_registration_/),
        },
      },
    }])
  })
})
