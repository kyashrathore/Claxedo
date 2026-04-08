import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { WebSocketCloseError } from "../../../overrides/components/terminal-connection"

const stats = {
  mounts: [] as string[],
  cleanups: [] as string[],
}

let all: Accessor<Array<{ id: string; title: string }>> = () => []
const ensure = vi.fn()
const clone = vi.fn()
const own = vi.fn()
const replaceId = vi.fn()
let issue: string | undefined
let fired = new Set<string>()

vi.mock("@/components/terminal", () => ({
  Terminal: (props: { pty: { id: string }; onConnectError?: (error: unknown) => void }) => {
    onMount(() => {
      stats.mounts.push(props.pty.id)
      if (issue === props.pty.id && !fired.has(props.pty.id)) {
        fired.add(props.pty.id)
        queueMicrotask(() => {
          props.onConnectError?.(new WebSocketCloseError(1008, "Session not found"))
        })
      }
    })
    onCleanup(() => {
      stats.cleanups.push(props.pty.id)
    })
    return <div data-testid="terminal" data-pty-id={props.pty.id} />
  },
}))

vi.mock("@/context/terminal", () => ({
  useTerminal: () => ({
    all: () => all(),
    ensure,
    new: vi.fn(),
    clone,
    own,
  }),
}))

vi.mock("../../context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    groupTabs: () => ({
      items: () => [{ id: "tab-1", type: "terminal", terminalId: "pty-old" }],
      patch: vi.fn(),
      addFile: vi.fn(),
      setActive: vi.fn(),
    }),
    terminal: {
      own,
      replaceId,
      isTracked: () => true,
      agentStatus: () => "idle",
      setAgentStatus: vi.fn(),
      getTabAgentStatus: () => ({ loading: false, done: false, attention: false }),
    },
    multiPane: {
      setContent: vi.fn(),
    },
    patchTab: vi.fn(),
    dispatch: vi.fn(),
  }),
}))

vi.mock("./terminal-fit", () => ({
  requestTerminalFitOnPaneChange: vi.fn(),
}))

const { PaneTerminal } = await import("./pane-terminal")

describe("PaneTerminal", () => {
  afterEach(() => {
    cleanup()
    stats.mounts.length = 0
    stats.cleanups.length = 0
    all = () => []
    ensure.mockReset()
    clone.mockReset()
    own.mockReset()
    replaceId.mockReset()
    issue = undefined
    fired = new Set()
  })

  test("remounts Terminal when the pane PTY id changes", async () => {
    const [ptys, setPtys] = createSignal([{ id: "pty-old", title: "Codex" }])
    const [id, setId] = createSignal("pty-old")
    all = ptys

    const view = render(() => (
      <PaneTerminal
        tabId="tab-1"
        leafId="leaf-1"
        groupId="group-1"
        directory="/workspace"
        terminalId={id()}
      />
    ))

    await waitFor(() => {
      expect(view.getByTestId("terminal").getAttribute("data-pty-id")).toBe("pty-old")
    })
    expect(stats.mounts).toEqual(["pty-old"])
    expect(stats.cleanups).toEqual([])

    setPtys([{ id: "pty-new", title: "Codex" }])
    setId("pty-new")

    await waitFor(() => {
      expect(view.getByTestId("terminal").getAttribute("data-pty-id")).toBe("pty-new")
    })
    expect(stats.mounts).toEqual(["pty-old", "pty-new"])
    expect(stats.cleanups).toEqual(["pty-old"])
  })

  test("does not remount Terminal when the PTY store node updates in place", async () => {
    const [ptys, setPtys] = createStore([{ id: "pty-1", title: "Codex" }])
    all = () => ptys

    const view = render(() => (
      <PaneTerminal
        tabId="tab-1"
        leafId="leaf-1"
        groupId="group-1"
        directory="/workspace"
        terminalId="pty-1"
      />
    ))

    await waitFor(() => {
      expect(view.getByTestId("terminal").getAttribute("data-pty-id")).toBe("pty-1")
    })
    expect(stats.mounts).toEqual(["pty-1"])
    expect(stats.cleanups).toEqual([])

    setPtys(0, "title", "Renamed")

    await waitFor(() => {
      expect(view.getByTestId("terminal").getAttribute("data-pty-id")).toBe("pty-1")
    })
    expect(stats.mounts).toEqual(["pty-1"])
    expect(stats.cleanups).toEqual([])
  })

  test("renders the cloned PTY after a 1008 reconnect error", async () => {
    const [ptys, setPtys] = createSignal([{ id: "pty-old", title: "Claude" }])
    all = ptys
    issue = "pty-old"
    clone.mockImplementation(async (id: string) => {
      setPtys([
        { id: "pty-old", title: "Claude" },
        { id: "pty-new", title: "Claude" },
      ])
      return id === "pty-old" ? "pty-new" : id
    })

    const view = render(() => (
      <PaneTerminal
        tabId="tab-1"
        leafId="leaf-1"
        groupId="group-1"
        directory="/workspace"
        terminalId="pty-old"
        title="Claude"
      />
    ))

    await waitFor(() => {
      expect(view.getByTestId("terminal").getAttribute("data-pty-id")).toBe("pty-new")
    })
    expect(clone).toHaveBeenCalledWith("pty-old")
    expect(replaceId).toHaveBeenCalledWith("tab-1", "pty-old", "pty-new")
    expect(stats.mounts.at(0)).toBe("pty-old")
    expect(stats.mounts.at(-1)).toBe("pty-new")
    expect(stats.mounts.filter((id) => id === "pty-new")).toHaveLength(1)
    expect(stats.cleanups).toContain("pty-old")
  })
})
