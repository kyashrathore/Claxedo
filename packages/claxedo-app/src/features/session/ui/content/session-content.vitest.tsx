import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionContent } from "./session-content"

const calls = vi.hoisted(() => ({
  directoryScope: vi.fn(),
  openSession: vi.fn(),
  sessionPage: vi.fn(),
}))

vi.mock("@/features/session/app-ports", () => ({
  useClaxedoState: () => ({
    meta: { ids: () => [], get: () => undefined },
    layout: { openSession: calls.openSession },
  }),
  useGlobalSync: () => ({
    data: { project: [] },
  }),
  useQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: () => [] }),
  }),
}))

vi.mock("../components/session-pane-scope", () => ({
	  SessionPaneScope: (props: {
	    children: unknown
	    directory: string
	    active?: () => boolean
	    sessionId?: () => string | undefined
	    onNavigateToSession?: (sessionId: string) => void
	  }) => {
	    calls.directoryScope()
	    return (
      <div
	        data-testid="session-pane-scope"
	        data-directory={props.directory}
	        data-session-id={props.sessionId?.() ?? ""}
	        data-active={props.active?.() ? "true" : "false"}
	      >
        <button type="button" onClick={() => props.onNavigateToSession?.("ses_next")}>next</button>
        {props.children}
      </div>
    )
  },
}))

vi.mock("@/features/session/ui/session-screen", () => ({
  default: () => {
    calls.sessionPage()
    return <div data-testid="session-page" />
  },
}))

afterEach(() => {
  calls.directoryScope.mockReset()
  calls.openSession.mockReset()
  calls.sessionPage.mockReset()
  cleanup()
})

describe("SessionContent", () => {
  test("renders workspace-less central sessions as no-backing surfaces", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "central-surface",
          type: "session",
          scope: "global",
          sessionId: "ses_central",
          content: {
            type: "session",
            sessionId: "ses_central",
            sessionRef: {
              sessionId: "ses_central",
              host: "central",
              toolSandbox: { kind: "virtual" },
            },
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    expect(screen.getByTestId("central-session-content")).toHaveAttribute("data-session-id", "ses_central")
    expect(screen.getByText("Session unavailable")).toBeTruthy()
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(calls.directoryScope).not.toHaveBeenCalled()
    expect(calls.sessionPage).not.toHaveBeenCalled()
  })

  test("keeps real central sessions on a real-session loading surface when a fallback workspace exists", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "central-surface",
          type: "session",
          scope: "global",
          sessionId: "ses_central",
          content: {
            type: "session",
            sessionId: "ses_central",
            sessionRef: {
              sessionId: "ses_central",
              host: "central",
              toolSandbox: { kind: "virtual" },
            },
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
        fallbackDirectory={() => "/work/repo"}
      />
    ))

    expect(screen.getByTestId("session-content")).toHaveAttribute("data-session-id", "ses_central")
    expect(screen.getByTestId("session-page-root")).toHaveAttribute("data-session-id", "ses_central")
    expect(screen.getByTestId("session-page-root")).toHaveAttribute("data-session-messages-ready", "false")
    expect(screen.queryByTestId("session-content-fallback-draft")).toBeNull()
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(screen.queryByText("No workspace backing")).toBeNull()
    expect(calls.directoryScope).not.toHaveBeenCalled()
    expect(calls.sessionPage).not.toHaveBeenCalled()
  })

  test("keeps local legacy session routes on the real session composer path", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "legacy-surface",
          type: "session",
          scope: "directory",
          directory: "/work/repo",
          sessionId: "ses_legacy",
          content: { type: "session", directory: "/work/repo", sessionId: "ses_legacy" },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    expect(screen.getByTestId("session-pane-scope")).toBeTruthy()
    expect(screen.getByTestId("session-page")).toBeTruthy()
    expect(screen.queryByText("Missing session identity")).toBeNull()
    expect(screen.queryByText("Missing workspace")).toBeNull()
    expect(calls.directoryScope).toHaveBeenCalled()
    expect(calls.sessionPage).toHaveBeenCalled()
  })

  test("does not mount the heavy session page while the session surface is stashed", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "stashed-surface",
          type: "session",
          scope: "directory",
          directory: "/work/repo",
          sessionId: "ses_stashed",
          content: { type: "session", directory: "/work/repo", sessionId: "ses_stashed" },
        }}
        ctx={{ paneId: "", isVisible: () => false }}
      />
    ))

    expect(screen.getByTestId("session-content-stashed")).toHaveAttribute("data-session-id", "ses_stashed")
    expect(screen.getByTestId("session-content-stashed")).toHaveAttribute("data-session-directory", "/work/repo")
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(calls.directoryScope).not.toHaveBeenCalled()
    expect(calls.sessionPage).not.toHaveBeenCalled()
  })

  test("keeps activated session pages mounted while stashed for fast restores", () => {
    const [visible, setVisible] = createSignal(true)
    render(() => (
      <SessionContent
        meta={{
          id: "retained-surface",
          type: "session",
          scope: "directory",
          directory: "/work/repo",
          sessionId: "ses_retained",
          content: { type: "session", directory: "/work/repo", sessionId: "ses_retained" },
        }}
        ctx={{ paneId: "pane-1", isVisible: visible }}
      />
    ))

    expect(screen.getByTestId("session-page")).toBeTruthy()

    setVisible(false)

    expect(screen.queryByTestId("session-content-stashed")).toBeNull()
    expect(screen.getByTestId("session-content")).toHaveAttribute("data-session-id", "ses_retained")
    expect(screen.getByTestId("session-page")).toBeTruthy()
  })

  test("keeps central sessions with a directory but virtual tools on a real-session loading surface", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "central-authz-surface",
          type: "session",
          scope: "global",
          directory: "ws_authz",
          sessionId: "ses_authz",
          content: {
            type: "session",
            directory: "ws_authz",
            sessionId: "ses_authz",
            sessionRef: {
              sessionId: "ses_authz",
              host: "central",
              workspaceId: "ws_authz",
              toolSandbox: { kind: "virtual" },
            },
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    expect(screen.getByTestId("session-content")).toHaveAttribute("data-session-id", "ses_authz")
    expect(screen.getByTestId("session-page-root")).toHaveAttribute("data-session-id", "ses_authz")
    expect(screen.getByTestId("session-page-root")).toHaveAttribute("data-session-messages-ready", "false")
    expect(screen.queryByTestId("session-content-fallback-draft")).toBeNull()
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(screen.queryByText("No workspace backing")).toBeNull()
    expect(calls.directoryScope).not.toHaveBeenCalled()
    expect(calls.sessionPage).not.toHaveBeenCalled()
  })

  test("retargets the current session ref when nested content opens another session", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "workspace-surface",
          type: "session",
          scope: "directory",
          directory: "workspace:ws_cloud",
          sessionId: "ses_current",
          content: {
            type: "session",
            directory: "workspace:ws_cloud",
            sessionId: "ses_current",
            sessionRef: {
              sessionId: "ses_current",
              host: "workspace",
              workspaceId: "ws_cloud",
              toolSandbox: { kind: "workspace", workspaceId: "ws_cloud", hosting: "cloud" },
            },
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    fireEvent.click(screen.getByText("next"))

    expect(calls.openSession).toHaveBeenCalledWith("workspace:ws_cloud", "ses_next", "Session", {
      sessionRef: {
        sessionId: "ses_next",
        host: "workspace",
        workspaceId: "ws_cloud",
        toolSandbox: { kind: "workspace", workspaceId: "ws_cloud", hosting: "cloud" },
      },
    })
  })
})
