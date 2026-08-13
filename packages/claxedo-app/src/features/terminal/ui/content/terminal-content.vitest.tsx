import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type Accessor } from "solid-js"

const h = vi.hoisted(() => ({
  ptys: [
    { id: "pty-one", title: "Terminal 1", cwd: "/repo" },
    { id: "pty-two", title: "Terminal 2", cwd: "/repo" },
  ],
  terminalNew: vi.fn(),
  ensure: vi.fn(),
  update: vi.fn(),
  terminalRender: vi.fn(),
  fit: vi.fn(),
  navigate: vi.fn(),
  metaPatch: vi.fn(),
  loadSessionPreview: vi.fn(async () => undefined as {
    terminalId: string
    eventType?: string
    updatedAt: number
  } | undefined),
  isAgentStatusTracked: vi.fn(() => false),
  agentStatus: vi.fn(() => "idle" as const),
  setAgentStatus: vi.fn(),
  pathname: "/w/%2Frepo/session",
  sdkWorkspaceId: "ws_terminal" as string | undefined,
  resolveRecovery: vi.fn((_alias: unknown, id: string) => id),
}))

vi.mock("@/features/terminal/ui/terminal", () => ({
  Terminal: (props: { pty: { id: string } }) => {
    h.terminalRender(props.pty.id)
    return <div data-testid={`terminal-${props.pty.id}`}>terminal {props.pty.id}</div>
  },
}))

vi.mock("@/features/terminal/providers/provider", () => ({
  useTerminal: () => ({
    all: () => h.ptys,
    new: h.terminalNew,
    ensure: h.ensure,
    update: h.update,
  }),
}))

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ get pathname() { return h.pathname } }),
  useNavigate: () => h.navigate,
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch: vi.fn() }),
}))

vi.mock("../../../session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: unknown }) => <>{props.children}</>,
}))

vi.mock("../../workbench/terminal-fit", () => ({
  requestTerminalFitOnPaneChange: h.fit,
}))

vi.mock("../../lib/terminal-session-preview", () => ({
  aliasTerminalSessionPreview: vi.fn(),
  loadTerminalSessionPreview: h.loadSessionPreview,
}))

vi.mock("../../lib/terminal-log-summary", () => ({
  aliasTerminalLogSummary: vi.fn(),
}))

vi.mock("../../workbench/pane-terminal-recovery", () => ({
  pendingRecovery: vi.fn(() => undefined),
  resolveRecovery: h.resolveRecovery,
  trackRecovery: vi.fn(),
}))

vi.mock("@/platform/api/api", () => ({
  getClaxedoServerUrl: () => "http://localhost:3001",
  normalizeUrl: (value: string) => value.replace(/\/+$/, ""),
}))

vi.mock("@/platform/runtime/workspace-runtime-record", () => ({
  resolveWorkspaceRuntime: vi.fn(async () => null),
}))

vi.mock("../../../../app/workbench/state/index", () => ({
  useClaxedoState: () => ({
    terminal: {
      own: vi.fn(),
      replaceId: vi.fn(),
      queueCreateForContent: vi.fn(),
      peekCreateForContent: vi.fn(() => undefined),
      consumeCreateForContent: vi.fn(() => undefined),
      isTracked: h.isAgentStatusTracked,
      agentStatus: h.agentStatus,
      setAgentStatus: h.setAgentStatus,
    },
    meta: {
      patch: vi.fn(),
    },
    workspacePanel: {
      open: vi.fn(),
    },
  }),
}))

vi.mock("@/features/terminal/app-ports", () => ({
  SessionPaneScope: (props: { children: unknown }) => <>{props.children}</>,
  TerminalNewView: (props: {
    onLaunch: (input: { directory: string; workspaceId: string; title: string }) => void
  }) => (
    <button
      data-testid="launch-terminal"
      onClick={() => props.onLaunch({ directory: "/repo", workspaceId: "ws_selected", title: "Terminal" })}
    >
      Launch
    </button>
  ),
  useSDK: () => ({ get workspaceId() { return h.sdkWorkspaceId } }),
  useClaxedoState: () => ({
    terminal: {
      own: vi.fn(),
      replaceId: vi.fn(),
      queueCreateForContent: vi.fn(),
      peekCreateForContent: vi.fn(() => undefined),
      consumeCreateForContent: vi.fn(() => undefined),
      isTracked: h.isAgentStatusTracked,
      agentStatus: h.agentStatus,
      setAgentStatus: h.setAgentStatus,
    },
    meta: { patch: h.metaPatch },
    workspacePanel: { open: vi.fn() },
  }),
  workspacePlacement: () => undefined,
}))

import { TerminalContent } from "./terminal-content"
import { workspaceTerminalRoute } from "@/platform/identity/route"

function terminalMeta(
  id: string,
  title: string,
  identity: { sessionId?: string; workspaceRouteId?: string } = {},
) {
  return {
    id: `content-${id}`,
    type: "terminal",
    scope: "directory",
    directory: "/repo",
    terminalId: id,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    content: {
      type: "terminal",
      directory: "/repo",
      terminalId: id,
      title,
      ...(identity.workspaceRouteId ? { workspaceRouteId: identity.workspaceRouteId } : {}),
    },
  } as const
}

describe("TerminalContent switching", () => {
  afterEach(() => {
    cleanup()
    h.ptys.splice(0, h.ptys.length, { id: "pty-one", title: "Terminal 1", cwd: "/repo" }, {
      id: "pty-two",
      title: "Terminal 2",
      cwd: "/repo",
    })
    h.terminalNew.mockReset()
    h.ensure.mockClear()
    h.update.mockClear()
    h.terminalRender.mockClear()
    h.fit.mockClear()
    h.navigate.mockClear()
    h.metaPatch.mockClear()
    h.loadSessionPreview.mockReset()
    h.loadSessionPreview.mockResolvedValue(undefined)
    h.isAgentStatusTracked.mockReset()
    h.isAgentStatusTracked.mockReturnValue(false)
    h.agentStatus.mockReset()
    h.agentStatus.mockReturnValue("idle")
    h.setAgentStatus.mockReset()
    h.pathname = "/w/%2Frepo/session"
    h.sdkWorkspaceId = "ws_terminal"
    h.resolveRecovery.mockImplementation((_alias: unknown, id: string) => id)
  })

  test("creates two terminal panes and keeps them mounted through repeated switches", async () => {
    h.ptys.splice(0)
    h.terminalNew.mockImplementation(async (options: { title?: string }) => {
      const title = options.title
      const id = title === "Terminal 2" ? "pty-two" : "pty-one"
      h.ptys.push({ id, title: title ?? "Terminal", cwd: "/repo" })
      return id
    })
    const [active, setActive] = createSignal<"one" | "two">("one")
    const visible = (value: "one" | "two"): Accessor<boolean> => () => active() === value

    render(() => (
      <>
        <TerminalContent
          meta={terminalMeta("pending-one", "Terminal 1")}
          ctx={{ paneId: "pane-one", isVisible: visible("one") }}
        />
        <TerminalContent
          meta={terminalMeta("pending-two", "Terminal 2")}
          ctx={{ paneId: "pane-two", isVisible: visible("two") }}
        />
      </>
    ))

    await waitFor(() => expect(screen.getByTestId("terminal-pty-one")).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(screen.queryByTestId("terminal-pty-two")).toBeNull()

    setActive("two")
    await waitFor(() => expect(screen.getByTestId("terminal-pty-two")).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(screen.getByTestId("terminal-pty-one")).toBeTruthy()

    for (const next of ["one", "two", "one", "two"] as const) {
      setActive(next)
      await waitFor(() => expect(screen.getByTestId(`terminal-pty-${next}`)).toBeTruthy())
      expect(screen.getByTestId("terminal-pty-one")).toBeTruthy()
      expect(screen.getByTestId("terminal-pty-two")).toBeTruthy()
    }

    expect(h.terminalNew).toHaveBeenCalledTimes(2)
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fit.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  test("passes the authoritative content session to managed PTY creation", async () => {
    h.ptys.splice(0)
    h.terminalNew.mockResolvedValue("pty-private")

    render(() => (
      <TerminalContent
        meta={terminalMeta("pending-private", "Private terminal", { sessionId: "session_private" })}
        ctx={{ paneId: "pane-private", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(h.terminalNew).toHaveBeenCalled())
    expect(h.terminalNew).toHaveBeenCalledWith({
      initialCommand: undefined,
      previousPtyId: undefined,
      sessionId: "session_private",
      title: "Private terminal",
    })
  })

  test("replaces the route when recovery swaps a real terminal id", async () => {
    h.ptys.splice(0, h.ptys.length, { id: "pty-new", title: "Terminal 1", cwd: "/repo" })
    h.pathname = workspaceTerminalRoute("ws_terminal", "pty-old")
    h.resolveRecovery.mockImplementation((_alias: unknown, id: string) => id === "pty-old" ? "pty-new" : id)

    render(() => (
      <TerminalContent
        meta={terminalMeta("pty-old", "Terminal 1")}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(screen.getByTestId("terminal-pty-new")).toBeTruthy())
    expect(h.navigate).toHaveBeenCalledWith(workspaceTerminalRoute("ws_terminal", "pty-new"), { replace: true })
  })

  test("hydrates terminal agent status from the daemon snapshot after a route reload", async () => {
    h.loadSessionPreview.mockResolvedValue({
      terminalId: "pty-one",
      eventType: "Busy",
      updatedAt: Date.now(),
    })

    render(() => (
      <TerminalContent
        meta={terminalMeta("pty-one", "Terminal 1", { workspaceRouteId: "ws_terminal" })}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(h.setAgentStatus).toHaveBeenCalledWith("pty-one", "working"))
  })

  test("does not overwrite a live lifecycle event with an older daemon snapshot", async () => {
    let resolvePreview!: (value: {
      terminalId: string
      eventType: string
      updatedAt: number
    }) => void
    h.loadSessionPreview.mockReturnValue(new Promise((resolve) => {
      resolvePreview = resolve
    }))

    render(() => (
      <TerminalContent
        meta={terminalMeta("pty-one", "Terminal 1", { workspaceRouteId: "ws_terminal" })}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(h.loadSessionPreview).toHaveBeenCalled())
    h.isAgentStatusTracked.mockReturnValue(true)
    resolvePreview({ terminalId: "pty-one", eventType: "Busy", updatedAt: Date.now() - 1_000 })
    await waitFor(() => expect(h.isAgentStatusTracked).toHaveBeenCalledWith("pty-one"))
    expect(h.setAgentStatus).not.toHaveBeenCalled()
  })

  test("replaces a local pending route from the surface workspace identity", async () => {
    h.ptys.splice(0)
    h.sdkWorkspaceId = undefined
    h.pathname = workspaceTerminalRoute("ws_local", "pending-local")
    h.terminalNew.mockImplementation(async () => {
      h.ptys.push({ id: "pty-created", title: "Terminal", cwd: "/repo" })
      return "pty-created"
    })

    render(() => (
      <TerminalContent
        meta={terminalMeta("pending-local", "Terminal", { workspaceRouteId: "ws_local" })}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(
      workspaceTerminalRoute("ws_local", "pty-created"),
      { replace: true },
    ))
  })

  test("uses producer-carried route identity when a local SDK adopts a real pty id", async () => {
    h.ptys.splice(0, h.ptys.length, { id: "pty-new", title: "Terminal 1", cwd: "/repo" })
    h.sdkWorkspaceId = undefined
    h.pathname = workspaceTerminalRoute("ws_selected", "pty-old")
    h.resolveRecovery.mockImplementation((_alias: unknown, id: string) => id === "pty-old" ? "pty-new" : id)

    render(() => (
      <TerminalContent
        meta={{
          ...terminalMeta("pty-old", "Terminal 1"),
          content: {
            ...terminalMeta("pty-old", "Terminal 1").content,
            workspaceRouteId: "ws_selected",
          },
        }}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(screen.getByTestId("terminal-pty-new")).toBeTruthy())
    expect(h.navigate).toHaveBeenCalledWith(workspaceTerminalRoute("ws_selected", "pty-new"), { replace: true })
  })

  test("stores the selected route identity before launching a terminal creator", async () => {
    render(() => (
      <TerminalContent
        meta={terminalMeta("new", "New Terminal")}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await fireEvent.click(screen.getByTestId("launch-terminal"))

    expect(h.metaPatch).toHaveBeenCalledWith("content-new", expect.objectContaining({
      content: expect.objectContaining({ workspaceRouteId: "ws_selected" }),
    }))
    expect(h.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/w\/ws_selected\/terminal\/pending-/))
  })
})
