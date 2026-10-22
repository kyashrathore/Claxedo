import { expect, test } from "bun:test"
import { CORE_HOSTED_OPERATIONS, hostedOperationTable } from "./hosted-operations"

const CORE = hostedOperationTable()

test("connection reads expose only the fixed read-only route", () => {
  expect(CORE.resolve("workspace.connection.read", { id: "ws/a", method: "POST", url: "https://evil.test" })).toEqual({ method: "GET", path: "/api/workspace/ws%2Fa/connection" })
  expect(CORE_HOSTED_OPERATIONS["workspace.connection.read"].exposure).toEqual({ renderer: true, app: false })
  expect(() => CORE.resolve("workspace.connection.read", {})).toThrow()
})

test("read-only connection accepts a stopped lease without a relay address", () => {
  expect(CORE.decode("workspace.connection.read", { status: "stopped", workspaceId: "ws_1" })).toEqual({ status: "stopped", workspaceId: "ws_1" })
  expect(() => CORE.decode("workspace.connection.read", {})).toThrow()
})

test("shared reads expose the fixed catalog and require the exact session for a connection", () => {
  expect(CORE.resolve("session.shared.list", { url: "https://evil.test" })).toEqual({ method: "GET", path: "/api/workspace/shared-sessions" })
  expect(CORE.resolve("session.connection.read", { id: "ws_1", sessionId: "ses_1", scope: "workspace", method: "POST" })).toEqual({ method: "GET", path: "/api/workspace/ws_1/connection?sessionId=ses_1" })
  expect(CORE_HOSTED_OPERATIONS["session.shared.list"].exposure).toEqual({ renderer: true, app: false })
  expect(CORE_HOSTED_OPERATIONS["session.connection.read"].exposure).toEqual({ renderer: true, app: false })
  expect(() => CORE.resolve("session.connection.read", { id: "ws_1" })).toThrow()
  const row = { session_id: "ses_1", workspace_id: "ws_1", project_id: "prj_1", title: null, owner_name: "Ada", level: "follow" as const }
  expect(CORE.decode("session.shared.list", { sessions: [row] })).toEqual({ sessions: [row] })
  expect(() => CORE.decode("session.shared.list", { sessions: [row, { ...row, level: "owner" }] })).toThrow()
})

test("session reservation exposes only the authority's fixed create reservation route", () => {
  expect(CORE.resolve("session.reserve", { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "fork" })).toEqual({ method: "POST", path: "/api/control/session-registrations/reserve", body: { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "create" } })
  expect(CORE_HOSTED_OPERATIONS["session.reserve"].exposure).toEqual({ renderer: true, app: false })
  expect(() => CORE.resolve("session.reserve", { workspaceId: "ws_1" })).toThrow()
})

test("a session connection mint names only the session on the fixed connection route", () => {
  expect(CORE.resolve("session.connection.mint", { id: "ws_1", sessionId: "ses_1", previousJti: "jti_1" })).toEqual({
    method: "POST",
    path: "/api/workspace/ws_1/connection",
    body: { session: { sessionId: "ses_1" } },
  })
  expect(CORE_HOSTED_OPERATIONS["session.connection.mint"].exposure).toEqual({ renderer: true, app: false })
  expect(() => CORE.resolve("session.connection.mint", { id: "ws_1" })).toThrow()
})

test("a workspace connection mint is a person's retry only when the caller says so", () => {
  expect(CORE.resolve("workspace.connection.mint", { id: "ws_1", retry: true })).toEqual({ method: "POST", path: "/api/workspace/ws_1/connection", body: { retry: true } })
  expect(CORE.resolve("workspace.connection.mint", { id: "ws_1" })).toEqual({ method: "POST", path: "/api/workspace/ws_1/connection", body: {} })
})

test("a workspace connection mint asks for the deployment's image only when the person asked to update", () => {
  expect(CORE.resolve("workspace.connection.mint", { id: "ws_1", retry: true, updateImage: true })).toEqual({ method: "POST", path: "/api/workspace/ws_1/connection", body: { retry: true, updateImage: true } })
})

test("a session reservation carries the harness it will run", () => {
  const harness = { id: "pi", access: "native" }
  expect(CORE.resolve("session.reserve", { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", harness })).toMatchObject({
    body: { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", harness, kind: "create" },
  })
})
