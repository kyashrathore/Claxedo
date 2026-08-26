import { describe, expect, test } from "bun:test"
import { parseShellRoute } from "@/platform/identity/route"
import { resolveWorkspaceRoute, shellRouteWorkspaceId } from "./workspace-route-resolution"

describe("workspace route resolution", () => {
  test("resolves an opaque workspace id only from its authoritative runtime record", () => {
    const route = parseShellRoute("/w/d3NfZG9fbm90X2RlY29kZQ/session/ses_1")

    expect(shellRouteWorkspaceId(route)).toBe("d3NfZG9fbm90X2RlY29kZQ")
    expect(resolveWorkspaceRoute(route, undefined)).toBeUndefined()
    expect(
      resolveWorkspaceRoute(route, {
        workspaceId: "different-workspace",
        directory: "/repo/wrong",
      }),
    ).toBeUndefined()
    expect(
      resolveWorkspaceRoute(route, {
        workspaceId: "d3NfZG9fbm90X2RlY29kZQ",
        directory: "/repo/canonical",
      }),
    ).toEqual({
      workspaceId: "d3NfZG9fbm90X2RlY29kZQ",
      directory: "/repo/canonical",
    })
  })

  test("keeps legacy directory decoding isolated to the legacy route parser", () => {
    const route = parseShellRoute("/L3JlcG8vbGVnYWN5/session/ses_1")

    expect(shellRouteWorkspaceId(route)).toBeUndefined()
    expect(resolveWorkspaceRoute(route, undefined)).toEqual({ directory: "/repo/legacy" })
  })
})
