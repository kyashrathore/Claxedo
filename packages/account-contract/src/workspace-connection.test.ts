import { expect, test } from "bun:test"
import { decodeHostedResult, HOSTED_OPERATIONS, resolveHostedOperation } from "./hosted-operations"

test("connection reads expose only the fixed read-only route", () => {
  expect(resolveHostedOperation("workspace.connection.read", { id: "ws/a", method: "POST", url: "https://evil.test" })).toEqual({ method: "GET", path: "/api/workspace/ws%2Fa/connection" })
  expect(HOSTED_OPERATIONS["workspace.connection.read"].exposure).toEqual({ renderer: true, app: false })
  expect(() => resolveHostedOperation("workspace.connection.read", {})).toThrow()
})

test("read-only connection accepts a stopped lease without a relay address", () => {
  expect(decodeHostedResult("workspace.connection.read", { status: "stopped", workspaceId: "ws_1" })).toEqual({ status: "stopped", workspaceId: "ws_1" })
  expect(() => decodeHostedResult("workspace.connection.read", {})).toThrow()
})

test("shared reads expose the fixed catalog and require the exact session for a connection", () => {
  expect(resolveHostedOperation("session.shared.list", { url: "https://evil.test" })).toEqual({ method: "GET", path: "/api/workspace/shared-sessions" })
  expect(resolveHostedOperation("session.connection.read", { id: "ws_1", sessionId: "ses_1", scope: "workspace", method: "POST" })).toEqual({ method: "GET", path: "/api/workspace/ws_1/connection?sessionId=ses_1" })
  expect(HOSTED_OPERATIONS["session.shared.list"].exposure).toEqual({ renderer: true, app: false })
  expect(HOSTED_OPERATIONS["session.connection.read"].exposure).toEqual({ renderer: true, app: false })
  expect(() => resolveHostedOperation("session.connection.read", { id: "ws_1" })).toThrow()
  const row = { session_id: "ses_1", workspace_id: "ws_1", project_id: "prj_1", title: null, owner_name: "Ada", level: "follow" as const }
  expect(decodeHostedResult("session.shared.list", { sessions: [row] })).toEqual({ sessions: [row] })
  expect(() => decodeHostedResult("session.shared.list", { sessions: [row, { ...row, level: "owner" }] })).toThrow()
})

test("session reservation exposes only the authority's fixed create reservation route", () => {
  expect(resolveHostedOperation("session.reserve", { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "fork" })).toEqual({ method: "POST", path: "/api/control/session-registrations/reserve", body: { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "create" } })
  expect(HOSTED_OPERATIONS["session.reserve"].exposure).toEqual({ renderer: true, app: false })
  expect(() => resolveHostedOperation("session.reserve", { workspaceId: "ws_1" })).toThrow()
})

test("a session connection mint names only the session on the fixed connection route", () => {
  expect(resolveHostedOperation("session.connection.mint", { id: "ws_1", sessionId: "ses_1", previousJti: "jti_1" })).toEqual({
    method: "POST",
    path: "/api/workspace/ws_1/connection",
    body: { session: { sessionId: "ses_1" } },
  })
  expect(HOSTED_OPERATIONS["session.connection.mint"].exposure).toEqual({ renderer: true, app: false })
  expect(() => resolveHostedOperation("session.connection.mint", { id: "ws_1" })).toThrow()
})

test("a session reservation carries the harness it will run", () => {
  const harness = { id: "pi", access: "native" }
  expect(resolveHostedOperation("session.reserve", { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", harness })).toMatchObject({
    body: { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", harness, kind: "create" },
  })
})
