import { beforeEach, describe, expect, test } from "bun:test"
import { openWorkspaceScopeIds } from "./workspace-scope-ids"
import type { ContentMeta } from "../../../app/workbench/state/index"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeEach(() => configureAppPortsForTest())

describe("openWorkspaceScopeIds", () => {
  test("limits workspace scopes to the active workspace and visible panes", () => {
    const meta = new Map<string, ContentMeta>([
      ["visible-session", {
        id: "visible-session",
        type: "session",
        directory: "/repo/main",
        sessionId: "ses-visible",
        content: {
          type: "session",
          directory: "/repo/main",
          sessionId: "ses-visible",
        },
      }],
      ["hidden-stale-session", {
        id: "hidden-stale-session",
        type: "session",
        directory: "workspace:ws_stale",
        sessionId: "ses-stale",
        content: {
          type: "session",
          directory: "workspace:ws_stale",
          sessionId: "ses-stale",
        },
      }],
    ])

    expect(openWorkspaceScopeIds({
      activeDirectory: "/repo/main",
      visiblePanes: [{ id: "pane-1", contentId: "visible-session" }],
      meta: (id) => meta.get(id),
    })).toEqual(["/repo/main"])
  })

  test("uses the session ref backing for visible relay sessions", () => {
    const meta = new Map<string, ContentMeta>([
      ["visible-session", {
        id: "visible-session",
        type: "session",
        directory: "/workspace",
        sessionId: "ses-cloud",
        content: {
          type: "session",
          directory: "/workspace",
          sessionId: "ses-cloud",
          sessionRef: {
            sessionId: "ses-cloud",
            host: "workspace",
            workspaceId: "ws_cloud_1",
            toolSandbox: {
              kind: "workspace",
              workspaceId: "ws_cloud_1",
              hosting: "cloud",
            },
          },
        },
      }],
    ])

    expect(openWorkspaceScopeIds({
      visiblePanes: [{ id: "pane-1", contentId: "visible-session" }],
      meta: (id) => meta.get(id),
    })).toEqual(["/workspace", "ws_cloud_1"])
  })

  test("adds canonical workspace id scopes for visible terminal surfaces", () => {
    const meta = new Map<string, ContentMeta>([
      ["visible-terminal", {
        id: "visible-terminal",
        type: "terminal",
        directory: "workspace:ws_cloud_1",
        terminalId: "pending-1",
        content: {
          type: "terminal",
          directory: "workspace:ws_cloud_1",
          terminalId: "pending-1",
          title: "Claude",
        },
      }],
    ])

    expect(openWorkspaceScopeIds({
      visiblePanes: [{ id: "pane-1", contentId: "visible-terminal" }],
      meta: (id) => meta.get(id),
    })).toEqual(["workspace:ws_cloud_1", "ws_cloud_1"])
  })
})
