/**
 * ProcessPanePanel – Component integration tests
 *
 * Renders ProcessPanePanel into JSDOM and asserts DOM state for each
 * combination of ptyId / status. Mocks the Terminal component (needs
 * xterm/WebSocket) with a simple div.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent } from "@solidjs/testing-library"

// ---------------------------------------------------------------------------
// Mocks — stub heavy dependencies
// ---------------------------------------------------------------------------

vi.mock("@/features/terminal/ui/terminal", () => ({
  Terminal: (props: any) => (
    <div data-testid="process-terminal" data-pty={props.pty?.id}>
      {props.pty?.title}
    </div>
  ),
}))

// Partial mock: `@/ui/icons/config` re-exports `iconLibrary` from this module and
// `ClaxedoIcon` reads it, so replacing the module wholesale breaks every render
// that reaches a Claxedo glyph. Keep the real exports and override only `Icon`.
vi.mock("@opencode-ai/ui/icon", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Icon: (props: any) => <span data-icon={props.name} />,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: any) => (
    <button data-icon={props.icon} onClick={props.onClick} aria-label={props["aria-label"]} />
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: any) => <>{props.children}</>,
}))

import { ProcessPanePanel, type ProcessPanePanelProps } from "./process-pane-panel"
import { setProcessToolbarSlot } from "@/ui/controls/portal-slot"

afterEach(() => {
  cleanup()
  setProcessToolbarSlot(null)
  document.body.innerHTML = ""
})

// ---------------------------------------------------------------------------
// Props factory
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  id: "proc_1",
  name: "Dev Server",
  command: "npm run dev",
  args: [] as string[],
  autoStart: false,
  restartPolicy: "never" as const,
  maxRestarts: 3,
}

function defaults(overrides: Partial<ProcessPanePanelProps> = {}): ProcessPanePanelProps {
  return {
    config: BASE_CONFIG,
    process: undefined,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRestart: vi.fn(),
    onResolveConflict: vi.fn(),
    renderTerminal: (terminal) => (
      <div data-testid="process-terminal" data-pty={terminal.id}>{terminal.title}</div>
    ),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcessPanePanel UI rendering", () => {
  test("moves its header into the workspace toolbar without keeping a duplicate row", () => {
    const host = document.createElement("div")
    document.body.append(host)
    setProcessToolbarSlot(host)
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          portalHeader: true,
          onEdit: vi.fn(),
          process: { configId: "proc_1", status: "idle", restartCount: 0 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-pane-header']")).toBeNull()
    expect(host.querySelector("[data-testid='process-pane-header']")?.textContent).toContain("Dev Server")
    expect(host.querySelector("[aria-label='Start process']")).toBeNull()
    expect(host.querySelector("[aria-label='Edit process']")).not.toBeNull()
    expect(container.querySelector("[data-process-action='start-fallback']")).not.toBeNull()
  })

  test("renders terminal when ptyId exists and process is running", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", ptyId: "pty_1", status: "running", restartCount: 0 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
  })

  test("does not mount terminal while tab is inactive", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          active: false,
          process: { configId: "proc_1", ptyId: "pty_1", status: "running", restartCount: 0 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Inactive")
  })

  test("hides terminal and shows placeholder when ptyId is undefined", () => {
    const { container } = render(() => (
      <ProcessPanePanel {...defaults({ process: { configId: "proc_1", status: "idle", restartCount: 0 } })} />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Process not running")
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
    expect(container.querySelector("[data-process-action='start-fallback']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).toBeNull()
    // Restart hidden for dormant states (Start covers it)
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("shows crashed placeholder when process crashes (ptyId cleared — PTY is dead)", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "crashed", restartCount: 0, exitCode: 1 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Crashed")
    expect(container.textContent).toContain("exit 1")
    expect(container.querySelector("[data-process-action='start-fallback']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("shows launch failure instead of a starting placeholder", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: {
            configId: "proc_1",
            status: "crashed",
            restartCount: 0,
            launchError: "HTTP 404",
          },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Failed to start")
    expect(container.textContent).toContain("HTTP 404")
    expect(container.querySelector("[data-process-action='start-fallback']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).toBeNull()
  })

  test("shows transitional placeholder when starting without ptyId", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "starting", restartCount: 0 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Starting")
    expect(container.querySelector("[aria-label='Stop process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
  })

  test("hides all action buttons during stopping", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "stopping", restartCount: 0 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Stopping")
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("stop button fires onStop callback", () => {
    const onStop = vi.fn()
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", ptyId: "pty_1", status: "running", restartCount: 0 },
          onStop,
        })}
      />
    ))

    const stopBtn = container.querySelector("[aria-label='Stop process']") as HTMLElement
    expect(stopBtn).not.toBeNull()
    fireEvent.click(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  test("start button fires onStart callback", () => {
    const onStart = vi.fn()
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "idle", restartCount: 0 },
          onStart,
        })}
      />
    ))

    const startBtn = container.querySelector("[data-process-action='start-fallback']") as HTMLElement
    expect(startBtn).not.toBeNull()
    fireEvent.click(startBtn)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  test("restart button hidden when idle (Start covers it)", () => {
    const { container } = render(() => (
      <ProcessPanePanel {...defaults({ process: { configId: "proc_1", status: "idle", restartCount: 0 } })} />
    ))
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("restart button visible when running", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", ptyId: "pty_1", status: "running", restartCount: 0 },
        })}
      />
    ))
    expect(container.querySelector("[aria-label='Restart process']")).not.toBeNull()
  })

  test("restart button hidden when crashed (Start covers it)", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "crashed", restartCount: 0, exitCode: 1 },
        })}
      />
    ))
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("restart button hidden when stopping", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "stopping", restartCount: 0 },
        })}
      />
    ))
    expect(container.querySelector("[aria-label='Restart process']")).toBeNull()
  })

  test("restart button fires onRestart callback", () => {
    const onRestart = vi.fn()
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", ptyId: "pty_1", status: "running", restartCount: 0 },
          onRestart,
        })}
      />
    ))

    const restartBtn = container.querySelector("[aria-label='Restart process']") as HTMLElement
    expect(restartBtn).not.toBeNull()
    fireEvent.click(restartBtn)
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  test("shows terminal and controls when restarting with ptyId", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", ptyId: "pty_1", status: "restarting", restartCount: 1 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Stop process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
  })

  test("shows transitional placeholder when restarting without ptyId", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: { configId: "proc_1", status: "restarting", restartCount: 1 },
        })}
      />
    ))

    expect(container.querySelector("[data-testid='process-terminal']")).toBeNull()
    expect(container.textContent).toContain("Restarting")
    expect(container.querySelector("[aria-label='Stop process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Restart process']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Start process']")).toBeNull()
  })

  test("shows inline port conflict overlay with port number and actions", () => {
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: {
            configId: "proc_1",
            status: "crashed",
            restartCount: 0,
            conflict: {
              type: "port-conflict",
              port: 3001,
              processName: "claxedo-server",
              directory: "/ws/other",
              pid: 1234,
            },
          },
        })}
      />
    ))

    expect(container.textContent).toContain("3001")
    expect(container.textContent).toContain("is in use")
    expect(container.textContent).toContain("Use another port")
    expect(container.textContent).toContain("Kill process")
  })

  test("port conflict overlay actions call the provided handlers", () => {
    const onResolveConflict = vi.fn()
    const { container } = render(() => (
      <ProcessPanePanel
        {...defaults({
          process: {
            configId: "proc_1",
            status: "crashed",
            restartCount: 0,
            conflict: {
              type: "port-conflict",
              port: 3001,
            },
          },
          onResolveConflict,
        })}
      />
    ))

    fireEvent.click(Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("Use another port"))!)
    expect(onResolveConflict).toHaveBeenCalledWith("pick-new")
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("Kill process"))!)
    expect(onResolveConflict).toHaveBeenCalledWith("kill-existing")
  })
})
