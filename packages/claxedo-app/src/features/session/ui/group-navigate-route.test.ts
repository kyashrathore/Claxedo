import { describe, expect, test } from "bun:test"
import { groupNavigateUrlSync } from "./group-navigate-route"
import { legacyDirectoryRouteKey, workspaceSessionRoute } from "@/platform/identity/route"

describe("groupNavigateUrlSync", () => {
  test("syncs when a workspace-session target switches to a different workspace than the URL", () => {
    // The behavior-5 regression: URL pinned to the auto-adopted local workspace,
    // in-pane navigation targets the cloud workspace's session root.
    expect(
      groupNavigateUrlSync({
        targetPath: workspaceSessionRoute("ws_core_harness_cloud"),
        currentPathname: "/w/local-ses_mock_runtime",
      }),
    ).toBe("/w/ws_core_harness_cloud/session")
  })

  test("syncs even when the stale URL is a bare workspace route (workspace kind)", () => {
    expect(
      groupNavigateUrlSync({
        targetPath: workspaceSessionRoute("ws_b"),
        currentPathname: "/w/ws_a",
      }),
    ).toBe("/w/ws_b/session")
  })

  test("does not sync when the target directory already matches the URL directory", () => {
    expect(
      groupNavigateUrlSync({
        targetPath: workspaceSessionRoute("ws_same"),
        currentPathname: "/w/ws_same/session",
      }),
    ).toBeUndefined()
  })

  test("does not sync when the target route carries no directory (session route)", () => {
    expect(
      groupNavigateUrlSync({
        targetPath: "/s/ses_1",
        currentPathname: "/w/ws_a/session",
      }),
    ).toBeUndefined()
  })

  test("syncs across legacy-directory targets that differ from the URL", () => {
    const target = `/${legacyDirectoryRouteKey("/repo/other")}/session`
    expect(
      groupNavigateUrlSync({
        targetPath: target,
        currentPathname: `/${legacyDirectoryRouteKey("/repo/main")}/session`,
      }),
    ).toBe(target)
  })

  test("does not sync a legacy-directory target that matches the current legacy directory", () => {
    const key = legacyDirectoryRouteKey("/repo/main")
    expect(
      groupNavigateUrlSync({
        targetPath: `/${key}/session`,
        currentPathname: `/${key}/session`,
      }),
    ).toBeUndefined()
  })
})
