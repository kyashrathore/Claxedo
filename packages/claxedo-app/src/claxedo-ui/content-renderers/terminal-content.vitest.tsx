import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
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
  pathname: "/w/%2Frepo/session",
  resolveRecovery: vi.fn((_alias: unknown, id: string) => id),
}))

vi.mock("@/components/terminal", () => ({
  Terminal: (props: { pty: { id: string } }) => {
    h.terminalRender(props.pty.id)
    return <div data-testid={`terminal-${props.pty.id}`}>terminal {props.pty.id}</div>
  },
}))

vi.mock("@/context/terminal", () => ({
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

vi.mock("@claxedo/context/platform", () => ({
  usePlatform: () => ({ fetch: vi.fn() }),
}))

vi.mock("../components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: unknown }) => <>{props.children}</>,
}))

vi.mock("../terminal/terminal-fit", () => ({
  requestTerminalFitOnPaneChange: h.fit,
}))

vi.mock("../utils/terminal-session-preview", () => ({
  aliasTerminalSessionPreview: vi.fn(),
  loadTerminalSessionPreview: vi.fn(async () => undefined),
}))

vi.mock("../utils/terminal-log-summary", () => ({
  aliasTerminalLogSummary: vi.fn(),
}))

vi.mock("../terminal/pane-terminal-recovery", () => ({
  pendingRecovery: vi.fn(() => undefined),
  resolveRecovery: h.resolveRecovery,
  trackRecovery: vi.fn(),
}))

vi.mock("../../utils/api", () => ({
  getClaxedoServerUrl: () => "http://localhost:3001",
  normalizeUrl: (value: string) => value.replace(/\/+$/, ""),
}))

vi.mock("../../cloud/runtime/workspace-runtime-store", () => ({
  resolveWorkspaceRuntime: vi.fn(async () => null),
}))

vi.mock("../state", () => ({
  useClaxedoState: () => ({
    terminal: {
      own: vi.fn(),
      replaceId: vi.fn(),
      peekCreateForContent: vi.fn(() => undefined),
      consumeCreateForContent: vi.fn(() => undefined),
      isTracked: vi.fn(() => false),
      agentStatus: vi.fn(() => "idle"),
      setAgentStatus: vi.fn(),
    },
    meta: {
      patch: vi.fn(),
    },
    workspacePanel: {
      open: vi.fn(),
    },
  }),
}))

import { TerminalContent } from "./terminal-content"
import { workspaceTerminalRoute } from "../../shell/identity/route"

function terminalMeta(id: string, title: string) {
  return {
    id: `content-${id}`,
    type: "terminal",
    scope: "directory",
    directory: "/repo",
    terminalId: id,
    content: {
      type: "terminal",
      directory: "/repo",
      terminalId: id,
      title,
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
    h.pathname = "/w/%2Frepo/session"
    h.resolveRecovery.mockImplementation((_alias: unknown, id: string) => id)
  })

  test("creates two terminal panes and keeps them mounted through repeated switches", async () => {
    h.ptys.splice(0)
    h.terminalNew.mockImplementation(async (_command?: string, title?: string) => {
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
    expect(screen.queryByTestId("terminal-pty-two")).toBeNull()

    setActive("two")
    await waitFor(() => expect(screen.getByTestId("terminal-pty-two")).toBeTruthy())
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

  test("replaces the route when recovery swaps a real terminal id", async () => {
    h.ptys.splice(0, h.ptys.length, { id: "pty-new", title: "Terminal 1", cwd: "/repo" })
    h.pathname = workspaceTerminalRoute("/repo", "pty-old")
    h.resolveRecovery.mockImplementation((_alias: unknown, id: string) => id === "pty-old" ? "pty-new" : id)

    render(() => (
      <TerminalContent
        meta={terminalMeta("pty-old", "Terminal 1")}
        ctx={{ paneId: "pane-one", isVisible: () => true }}
      />
    ))

    await waitFor(() => expect(screen.getByTestId("terminal-pty-new")).toBeTruthy())
    expect(h.navigate).toHaveBeenCalledWith(workspaceTerminalRoute("/repo", "pty-new"), { replace: true })
  })
})
