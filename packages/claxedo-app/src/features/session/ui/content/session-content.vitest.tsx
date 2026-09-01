import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionContent } from "./session-content"

const calls = vi.hoisted(() => ({
  directoryScope: vi.fn(),
  openSession: vi.fn(),
  sessionPage: vi.fn(),
  pendingTranscript: vi.fn<() => Promise<unknown> | undefined>(() => undefined),
  workspaceId: undefined as string | undefined,
}))

// The mount gate asks this whether the activating click already has a
// transcript read in flight for this surface (see session-mount-settle.ts).
// Left answering "no" it is transparent, which is what every test below that
// does not set it wants.
vi.mock("@/platform/sync/session-prefetch", () => ({
  getSessionPrefetchPromise: () => calls.pendingTranscript(),
}))

vi.mock("@/features/session/app-ports", () => ({
  useClaxedoState: () => ({
    meta: { ids: () => [], get: () => undefined },
    layout: { openSession: calls.openSession },
    workspacePanel: { state: () => ({ open: false }) },
  }),
  useGlobalSync: () => ({
    data: { project: [] },
  }),
  useQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: () => [] }),
  }),
}))

// This file's subject is which surface SessionContent ROUTES to, not what the
// environment card renders. The card reaches for a deep provider graph
// (useSDK, usePaneId, useShellQueryOptions, usePlatform, usePrompt, plus
// workspacePanel and focused-pane state), so satisfying it here would mean
// growing this mock to describe a component these tests never assert on.
// It has its own tests, and whether it mounts at all is covered by
// session-content-envcard.vitest.tsx.
vi.mock("./session-environment-card", () => ({
  SessionEnvironmentCardMount: () => null,
}))

// Same reason as the card above: the skeleton reaches for the language context,
// and this file's subject is which surface is routed to, not how the waiting
// one is drawn. The page root around it — the part readiness reads — is real.
vi.mock("@/features/session/ui/content/session-timeline-skeleton", () => ({
  SessionTimelineSkeleton: () => null,
}))

vi.mock("../components/session-pane-scope", () => ({
	  SessionPaneScope: (props: {
	    children: unknown
	    directory: string
	    active?: () => boolean
	    sessionId?: () => string | undefined
	    onNavigateToSession?: (sessionId: string) => void
	    workspaceId?: () => string | undefined
	  }) => {
	    calls.directoryScope()
	    calls.workspaceId = props.workspaceId?.()
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
  calls.pendingTranscript.mockReset()
  calls.pendingTranscript.mockReturnValue(undefined)
  calls.workspaceId = undefined
  cleanup()
})

describe("SessionContent", () => {
  test("passes the workspace route identity into a draft pane scope", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "workspace-draft",
          type: "session",
          scope: "directory",
          directory: "/local/project",
          sessionId: "new",
          content: {
            type: "session",
            directory: "/local/project",
            sessionId: "new",
            workspaceRouteId: "ws_cloud_route",
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    expect(calls.workspaceId).toBe("ws_cloud_route")
  })

  test("does not invent a directory for workspace-less non-Pi central sessions", () => {
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

    expect(screen.getByTestId("central-session-content")).toHaveTextContent("Session unavailable")
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(calls.directoryScope).not.toHaveBeenCalled()
    expect(calls.sessionPage).not.toHaveBeenCalled()
  })

  test("renders a directory-less Pi central session without synthesizing a directory", () => {
    render(() => (
      <SessionContent
        meta={{
          id: "central-pi-surface",
          type: "session",
          scope: "global",
          sessionId: "ses_pi",
          content: {
            type: "session",
            sessionId: "ses_pi",
            sessionRef: {
              sessionId: "ses_pi",
              host: "central",
              harness: { id: "pi" },
              toolSandbox: { kind: "virtual" },
            },
          },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    expect(screen.getByTestId("session-pane-scope")).toHaveAttribute("data-directory", "")
    expect(screen.getByTestId("session-page")).toBeTruthy()
    expect(calls.directoryScope).toHaveBeenCalledOnce()
    expect(calls.sessionPage).toHaveBeenCalledOnce()
  })

  test("renders central sessions through their fallback project scope", () => {
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

    expect(screen.getByTestId("session-pane-scope")).toHaveAttribute("data-directory", "/work/repo")
    expect(screen.getByTestId("session-page")).toBeTruthy()
    expect(calls.directoryScope).toHaveBeenCalledOnce()
    expect(calls.sessionPage).toHaveBeenCalledOnce()
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

  test("renders central sessions with a directory in that pane scope", () => {
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

    expect(screen.getByTestId("session-pane-scope")).toHaveAttribute("data-directory", "ws_authz")
    expect(screen.getByTestId("session-page")).toBeTruthy()
    expect(calls.directoryScope).toHaveBeenCalledOnce()
    expect(calls.sessionPage).toHaveBeenCalledOnce()
  })

  test("holds the session page until the activating click's transcript read settles", async () => {
    let release: (() => void) | undefined
    calls.pendingTranscript.mockReturnValue(new Promise<void>((resolve) => {
      release = resolve
    }))
    render(() => (
      <SessionContent
        meta={{
          id: "cold-surface",
          type: "session",
          scope: "directory",
          directory: "/work/repo",
          sessionId: "ses_cold",
          content: { type: "session", directory: "/work/repo", sessionId: "ses_cold", title: "Cold" },
        }}
        ctx={{ paneId: "pane-1", isVisible: () => true }}
      />
    ))

    // The pane scope and its providers are NOT deferred: only the page is, so
    // the transcript still hydrates into a live scope while the gate is shut.
    expect(screen.getByTestId("session-pane-scope")).toBeTruthy()
    expect(screen.queryByTestId("session-page")).toBeNull()
    expect(calls.sessionPage).not.toHaveBeenCalled()
    // What the user sees meanwhile is the page root the page itself would show
    // without messages — readiness queries can tell "assembling" from "absent".
    const root = screen.getByTestId("session-page-root")
    expect(root).toHaveAttribute("data-session-id", "ses_cold")
    expect(root).toHaveAttribute("data-session-first-fold-ready", "false")

    release!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByTestId("session-page")).toBeTruthy()
    expect(calls.sessionPage).toHaveBeenCalledOnce()
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
