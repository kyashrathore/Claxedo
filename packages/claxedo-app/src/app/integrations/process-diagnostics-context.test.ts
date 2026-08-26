import { describe, expect, test } from "bun:test"
import {
  buildProcessDiagnosticsContext,
  findPaneRoot,
  findSessionRoot,
  readSessionRenderMetrics,
} from "./process-diagnostics-context"
import type { ContentMeta } from "@/app/workbench/state/types"

describe("process diagnostics context", () => {
  test("attributes panes, stashed terminal tabs, workspace-panel tab, and session render size without content", () => {
    const content = new Map<string, ContentMeta>([
      [
        "surface-session",
        { id: "surface-session", type: "session", sessionId: "session-1", directory: "/private/repo" },
      ],
      [
        "surface-terminal-visible",
        { id: "surface-terminal-visible", type: "terminal", terminalId: "terminal-1", directory: "/private/repo" },
      ],
      [
        "surface-terminal-hidden",
        { id: "surface-terminal-hidden", type: "terminal", terminalId: "terminal-2", directory: "/private/repo" },
      ],
      ["surface-page-hidden", { id: "surface-page-hidden", type: "page", pageId: "secret-file-name" }],
    ])
    const result = buildProcessDiagnosticsContext({
      pathname: "/w/workspace-1/session/session-1",
      activeSessionId: "session-1",
      focusedPaneId: "pane-terminal",
      panes: [
        { id: "pane-session", contentId: "surface-session" },
        { id: "pane-terminal", contentId: "surface-terminal-visible" },
      ],
      contentIds: [...content.keys()],
      content: (id) => content.get(id),
      workspacePanel: {
        open: true,
        mode: "review",
        navigator: "changes",
        targetPaneId: "pane-terminal",
        focus: { kind: "file", path: "/private/repo/secret.ts", intent: "tab", version: 1 },
      },
      workspacePanelTab: "file",
      sessionRender: {
        sessionId: "session-1",
        messageCount: 250,
        conversationCount: 248,
        visibleUserCount: 50,
        renderedUserCount: 12,
        timelineRowCount: 90,
        mountedTimelineRowCount: 9,
        domNodeCount: 1_240,
      },
    })

    expect(result).toMatchObject({
      screen: "workspace-session",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      workbench: {
        focusedSurface: "terminal",
        focusedPaneId: "pane-terminal",
        paneCount: 2,
        surfaceCount: 4,
        stashedSurfaceCount: 2,
        paneSurfaceTypes: ["session", "terminal"],
      },
      terminalTabs: { total: 2, paneBound: 1, stashed: 1 },
      workspacePanel: {
        open: true,
        mode: "review",
        navigator: "changes",
        tab: "file",
        focus: "file",
        target: "focused-pane",
      },
      sessionRender: { domNodeCount: 1_240, mountedTimelineRowCount: 9 },
    })
    expect(JSON.stringify(result)).not.toContain("/private/repo")
    expect(JSON.stringify(result)).not.toContain("secret.ts")
    expect(JSON.stringify(result)).not.toContain("secret-file-name")
  })

  test("measures only numeric attributes and DOM count from the selected session pane", () => {
    document.body.innerHTML = `
      <section data-workbench-content data-pane-id="pane-other">
        <main data-testid="session-page-root" data-session-id="session-other"></main>
      </section>
      <section data-workbench-content data-pane-id="pane-session">
        <main
          data-testid="session-page-root"
          data-session-id="session-1"
          data-session-message-count="250"
          data-session-conversation-count="248"
          data-session-visible-user-count="50"
          data-session-rendered-user-count="12"
        >
          <div
            data-session-timeline-root
            data-session-timeline-row-count="90"
            data-session-timeline-key-count="9"
          ><span>private message text</span></div>
        </main>
      </section>
    `

    const pane = findPaneRoot(document, "pane-session")
    const session = pane && findSessionRoot(pane, "pane-session", "session-1")
    expect(session && readSessionRenderMetrics(session)).toEqual({
      messageCount: 250,
      conversationCount: 248,
      visibleUserCount: 50,
      renderedUserCount: 12,
      timelineRowCount: 90,
      mountedTimelineRowCount: 9,
      domNodeCount: 3,
    })
    document.body.replaceChildren()
  })

  test("includes the workspace sub-tab only for the review panel", () => {
    const context = buildProcessDiagnosticsContext({
      pathname: "/",
      panes: [],
      contentIds: [],
      content: () => undefined,
      workspacePanel: { open: true, mode: "processes" },
      workspacePanelTab: "stale-review-tab",
    })
    expect(context.workspacePanel.tab).toBeUndefined()
  })
})
