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

test("session reservation exposes only the authority's fixed create reservation route", () => {
  expect(resolveHostedOperation("session.reserve", { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "fork" })).toEqual({ method: "POST", path: "/api/control/session-registrations/reserve", body: { workspaceId: "ws_1", sessionId: "ses_1", operationId: "op_1", title: "Cloud", kind: "create" } })
  expect(HOSTED_OPERATIONS["session.reserve"].exposure).toEqual({ renderer: true, app: false })
  expect(() => resolveHostedOperation("session.reserve", { workspaceId: "ws_1" })).toThrow()
})
