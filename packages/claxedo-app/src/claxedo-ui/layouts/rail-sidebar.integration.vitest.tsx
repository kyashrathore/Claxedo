import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import type { TabItem } from "../context/claxedo-layout/types"
import type { Process } from "@claxedo/process/process"

const sync: any = {
  globalSessions: {
    store: {
      byProject: {
        p1: [],
      },
      global: [],
      byWorkspace: {
        "/ws/main": { total: 0, sessions: [] },
        "/ws/cloud": { total: 1, sessions: [] },
      },
      workspaceOrder: ["/ws/main", "/ws/cloud"],
      workspaceState: {
        "/ws/main": { hasMore: false, loading: false, cursor: undefined },
        "/ws/cloud": { hasMore: false, loading: false, cursor: undefined },
      },
      projectState: {
        p1: { hasMore: false, loading: false, cursor: undefined },
      },
    },
    reloadWorkspace: vi.fn(),
    loadMoreWorkspace: vi.fn(),
    loadMore: vi.fn(),
  },
}

const dialogShow = vi.fn()

const cfg = (id: string, name: string): Process.ProcessConfig => ({
  id,
  name,
  command: "npm",
  args: [],
  autoStart: false,
  restartPolicy: "never",
  maxRestarts: 3,
})

const proc = (configId: string, status: Process.Status): Process.ManagedProcess => ({
  configId,
  status,
  restartCount: 0,
})

const processState: Record<string, Process.ListResponse> = {}

const list = vi.fn<(dir: string) => Promise<Process.ListResponse>>(async () => ({
  configs: [],
  processes: [],
}))
const start = vi.fn<(dir: string, id: string, opts?: { interactive?: boolean }) => Promise<unknown>>(async () => true)
const stop = vi.fn<(dir: string, id: string) => Promise<boolean>>(async () => true)
const restart = vi.fn<(dir: string, id: string) => Promise<unknown>>(async () => true)

const scoped = new Map<string, Set<(event: { type: string; properties?: Record<string, unknown> }) => void>>()
const global = new Set<(event: { name: string; details: { type: string; properties?: Record<string, unknown> } }) => void>()

const emit = (dir: string, event: { type: string; properties?: Record<string, unknown> }) => {
  for (const fn of scoped.get(dir) ?? []) fn(event)
  for (const fn of global) fn({ name: dir, details: event })
}

const tab = (input: Partial<TabItem> & Pick<TabItem, "id" | "type" | "title" | "closable">): TabItem => ({
  directory: "/ws/main",
  ...input,
})

const groupTabs = {
  g1: {
    items: vi.fn((): TabItem[] => []),
    activeId: vi.fn((): string | null => null),
    setActive: vi.fn(),
    addProcess: vi.fn(() => "proc-tab-g1"),
  },
  g2: {
    items: vi.fn((): TabItem[] => []),
    activeId: vi.fn((): string | null => null),
    setActive: vi.fn(),
    addProcess: vi.fn(() => "proc-tab-g2"),
  },
}

const claxedo = {
  rail: {
    collapsed: () => false,
    pinned: () => true,
    width: () => 260,
    toggle: vi.fn(),
    trackPosition: vi.fn(),
    handleMouseLeave: vi.fn(),
    cancelCollapse: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
  },
  split: {
    groups: () => [{ id: "g1" }, { id: "g2" }],
    focusedId: vi.fn(() => "g1"),
    setFocus: vi.fn(),
  },
  processPane: {
    setTargetDirectory: vi.fn(),
  },
  multiPane: {
    focus: vi.fn(),
  },
  select: {
    multiPaneLeafView: vi.fn((): any[] => []),
  },
  groupTabs: (id: "g1" | "g2") => groupTabs[id],
}

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => claxedo,
}))

vi.mock("@opencode-ai/claxedo-app", () => ({
  useLanguage: () => ({
    t: (key: string) => key === "common.loadMore" ? "Load more" : key,
  }),
  useGlobalSync: () => sync,
  useServer: () => ({
    isLocal: () => true,
  }),
  usePlatform: () => ({
    fetch: globalThis.fetch,
  }),
  useGlobalSDK: () => ({
    event: {
      on: (dir: string, fn: (event: { type: string; properties?: Record<string, unknown> }) => void) => {
        const set = scoped.get(dir) ?? new Set()
        set.add(fn)
        scoped.set(dir, set)
        return () => set.delete(fn)
      },
      listen: (fn: (event: { name: string; details: { type: string; properties?: Record<string, unknown> } }) => void) => {
        global.add(fn)
        return () => global.delete(fn)
      },
    },
  }),
}))

vi.mock("@claxedo/process/client", () => ({
  createProcessClient: ({ directory }: { directory: string }) => ({
    list: () => list(directory),
    start: (id: string, opts?: { interactive?: boolean }) => start(directory, id, opts),
    restart: (id: string) => restart(directory, id),
    stop: (id: string) => stop(directory, id),
  }),
}))

vi.mock("../../utils/api", () => ({
  getClaxedoServerUrl: () => "http://localhost:3001",
}))

vi.mock("@solid-primitives/active-element", () => ({
  createFocusSignal: () => () => false,
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: dialogShow,
  }),
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: (props: Record<string, unknown>) => <span {...props} data-icon={props.name} />,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: Record<string, unknown>) => <button {...props} />,
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children?: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children?: JSX.Element }) => <>{props.children}</>
  const Trigger = (props: { children?: JSX.Element }) => <button>{props.children}</button>
  const CheckboxItem = (props: { children?: JSX.Element; onChange?: () => void }) => <button onClick={() => props.onChange?.()}>{props.children}</button>
  const RadioItem = (props: { children?: JSX.Element; onSelect?: () => void }) => <button onClick={() => props.onSelect?.()}>{props.children}</button>
  const Item = (props: { children?: JSX.Element; onSelect?: () => void }) => <button onClick={() => props.onSelect?.()}>{props.children}</button>
  return {
    DropdownMenu: Object.assign(Root, {
      Trigger,
      Portal: Root,
      Content: Root,
      Group: Root,
      GroupLabel: Root,
      RadioGroup: Root,
      RadioItem,
      Separator: Root,
      Sub: Root,
      SubTrigger: Trigger,
      SubContent: Root,
      CheckboxItem,
      Item,
    }),
  }
})

vi.mock("../../overrides/components/status-popover", () => ({
  StatusPopover: (props: { children?: JSX.Element | ((state: { overallHealthy: boolean; serverHealthy: boolean }) => JSX.Element) }) => (
    <>
      {typeof props.children === "function"
        ? props.children({ overallHealthy: true, serverHealthy: true })
        : props.children}
    </>
  ),
}))

vi.mock("../components/dialog-edit-project", () => ({
  DialogEditProject: () => null,
}))

vi.mock("../components/dialog-process-diagnostics", () => ({
  DialogProcessDiagnostics: () => null,
}))

import { RailSidebar, type ProjectItem } from "./rail-sidebar"

const projects: ProjectItem[] = [
  {
    id: "p1",
    worktree: "/ws/main",
    name: "Claxedo",
    sandboxes: ["/ws/cloud"],
    workspaces: {
      "/ws/main": {
        id: "ws-main",
        directory: "/ws/main",
        kind: "local",
      },
      "/ws/cloud": {
        id: "ws-cloud",
        directory: "/ws/cloud",
        kind: "cloud",
        workspace_name: "main",
      },
    },
  },
]

const renderSidebar = (input?: {
  activeWorkspaceId?: string
  workspaceSelector?: JSX.Element
  globalChatEnabled?: boolean
  workgraphEnabled?: boolean
}) =>
  render(() => (
    <RailSidebar
      projects={projects}
      activeProjectId="p1"
      activeWorkspaceId={input?.activeWorkspaceId ?? "/ws/main"}
      globalChatEnabled={input?.globalChatEnabled}
      onProjectSelect={() => {}}
      onWorkspaceSelect={() => {}}
      onSessionSelect={() => {}}
      onNewSession={() => {}}
      onNewWorkspace={() => {}}
      onNewProject={() => {}}
      workgraphEnabled={input?.workgraphEnabled}
      workspaceSelector={input?.workspaceSelector}
    />
  ))

const workspaceHeader = (dir: string) =>
  document.querySelector(`[data-testid="workspace-header"][data-workspace-id="${dir}"]`) as HTMLElement | null

const openProcesses = async () => {
  await waitFor(() => expect(screen.getByText("Processes")).toBeInTheDocument())
  await fireEvent.click(screen.getByText("Processes"))
}

beforeEach(() => {
  localStorage.clear()
  scoped.clear()
  global.clear()
  dialogShow.mockReset()
  list.mockReset()
  processState["/ws/main"] = {
    configs: [{ ...cfg("proc-a", "Dev server"), autoStart: true }, { ...cfg("proc-b", "Watcher"), autoStart: false }],
    processes: [proc("proc-a", "running")],
  }
  processState["/ws/cloud"] = { configs: [], processes: [] }
  list.mockImplementation(async (dir: string) => processState[dir] ?? { configs: [], processes: [] })
  start.mockReset()
  start.mockImplementation(async (dir: string, id: string) => {
    const hit = processState[dir]
    if (!hit) return true
    const procHit = hit.processes.find((item) => item.configId === id)
    if (procHit) procHit.status = "running"
    if (!procHit) hit.processes = [...hit.processes, proc(id, "running")]
    return true
  })
  stop.mockReset()
  stop.mockImplementation(async (dir: string, id: string) => {
    const hit = processState[dir]
    if (!hit) return true
    hit.processes = hit.processes.map((item) => item.configId === id ? { ...item, status: "stopped", ptyId: undefined } : item)
    return true
  })
  restart.mockReset()
  restart.mockImplementation(async (dir: string, id: string) => {
    const hit = processState[dir]
    if (!hit) return true
    const procHit = hit.processes.find((item) => item.configId === id)
    if (procHit) procHit.status = "running"
    if (!procHit) hit.processes = [...hit.processes, proc(id, "running")]
    return true
  })
  sync.globalSessions.store.global = []
  sync.globalSessions.store.byWorkspace["/ws/main"] = { total: 0, sessions: [] }
  sync.globalSessions.store.byWorkspace["/ws/cloud"] = { total: 1, sessions: [] }
  sync.globalSessions.reloadWorkspace.mockClear()
  sync.globalSessions.loadMoreWorkspace.mockClear()
  sync.globalSessions.loadMore.mockClear()
  claxedo.split.focusedId.mockReset()
  claxedo.split.focusedId.mockReturnValue("g1")
  claxedo.split.setFocus.mockClear()
  claxedo.processPane.setTargetDirectory.mockClear()
  claxedo.multiPane.focus.mockClear()
  claxedo.select.multiPaneLeafView.mockReset()
  claxedo.select.multiPaneLeafView.mockReturnValue([])
  groupTabs.g1.items.mockReset()
  groupTabs.g1.activeId.mockReset()
  groupTabs.g1.setActive.mockReset()
  groupTabs.g1.addProcess.mockReset()
  groupTabs.g1.addProcess.mockReturnValue("proc-tab-g1")
  groupTabs.g2.items.mockReset()
  groupTabs.g2.activeId.mockReset()
  groupTabs.g2.setActive.mockReset()
  groupTabs.g2.addProcess.mockReset()
  groupTabs.g2.addProcess.mockReturnValue("proc-tab-g2")
  groupTabs.g1.items.mockReturnValue([])
  groupTabs.g1.activeId.mockReturnValue(null)
  groupTabs.g2.items.mockReturnValue([])
  groupTabs.g2.activeId.mockReturnValue(null)
})

afterEach(() => {
  cleanup()
})

describe("RailSidebar workspace kind icon", () => {
  test("keeps header title visible when a workspace selector action is provided", () => {
    renderSidebar({
      workspaceSelector: <button aria-label="Workspace menu">+</button>,
    })

    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByText("Claxedo")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Workspace menu" })).toBeInTheDocument()
  })

  test("renders laptop for a local workspace section and cloud for a cloud workspace section", async () => {
    renderSidebar()

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    const local = workspaceHeader("/ws/main")
    const cloud = workspaceHeader("/ws/cloud")
    expect(local).toBeTruthy()
    expect(cloud).toBeTruthy()
    expect(within(local!).getByText("main")).toBeInTheDocument()
    expect(within(cloud!).getByText("main (cloud)")).toBeInTheDocument()
    expect(within(local!).getByTestId("section-kind-icon")).toHaveAttribute("data-icon", "laptop")
    expect(within(cloud!).getByTestId("section-kind-icon")).toHaveAttribute("data-icon", "cloud")
  })

  test("renders the active workspace even when it has no session group yet", async () => {
    renderSidebar({ activeWorkspaceId: "/ws/term" })

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    const term = workspaceHeader("/ws/term")
    expect(term).toBeTruthy()
    expect(within(term!).getByText("term")).toBeInTheDocument()
    expect(within(term!).getByTestId("section-kind-icon")).toHaveAttribute("data-icon", "laptop")
    expect(screen.queryByText("No sessions yet.")).not.toBeInTheDocument()
  })

  test("hides Global Chat sections when the flag is off", async () => {
    sync.globalSessions.store.global = [{
      id: "global-1",
      title: "Global session",
      directory: "/ws/main",
      projectID: "p1",
      tags: ["global"],
      attachments: [],
      time: { created: Date.now(), updated: Date.now() },
    }]

    renderSidebar()

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    expect(screen.queryByText("Global Chat")).not.toBeInTheDocument()
  })

  test("shows Global Chat sections when the flag is on", async () => {
    sync.globalSessions.store.global = [{
      id: "global-1",
      title: "Global session",
      directory: "/ws/main",
      projectID: "p1",
      tags: ["global"],
      attachments: [],
      time: { created: Date.now(), updated: Date.now() },
    }]

    renderSidebar({ globalChatEnabled: true })

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    expect(screen.getByText("Global Chat")).toBeInTheDocument()
  })

  test("hides the WorkGraph button when the flag is off", async () => {
    renderSidebar()

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    expect(screen.queryByText("workspace.workgraph")).not.toBeInTheDocument()
  })

  test("shows the WorkGraph button when the flag is on", async () => {
    renderSidebar({ workgraphEnabled: true })

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    expect(screen.getByText("workspace.workgraph")).toBeInTheDocument()
  })
})

describe("RailSidebar process rows", () => {
  test("renders process rows in workspace view from process state, not tabs", async () => {
    renderSidebar()

    await openProcesses()
    expect(screen.getByText("Dev server")).toBeInTheDocument()
    expect(screen.getByText("Watcher")).toBeInTheDocument()
  })

  test("does not show empty state when a workspace has process rows but no sessions", async () => {
    renderSidebar()

    expect(screen.queryByText("Processes")).not.toBeInTheDocument()
    expect(screen.queryByText("No sessions yet.")).not.toBeInTheDocument()
  })

  test("process subsection is collapsible", async () => {
    renderSidebar()

    await openProcesses()
    expect(screen.getByText("Dev server")).toBeInTheDocument()
    await fireEvent.click(screen.getByText("Processes"))
    expect(screen.queryByText("Dev server")).not.toBeInTheDocument()
    await fireEvent.click(screen.getByText("Processes"))
    expect(screen.getByText("Dev server")).toBeInTheDocument()
  })

  test("toggle hides and re-shows process rows and persists in localStorage", async () => {
    renderSidebar()

    await waitFor(() => expect(screen.getByText("Processes")).toBeInTheDocument())
    await fireEvent.click(screen.getByText("Show processes"))
    expect(screen.queryByText("Processes")).not.toBeInTheDocument()
    expect(localStorage.getItem("claxedo.session-view.v1")).toContain("\"processes\":\"hide\"")

    await fireEvent.click(screen.getByText("Show processes"))
    expect(screen.getByText("Processes")).toBeInTheDocument()
    expect(localStorage.getItem("claxedo.session-view.v1")).toContain("\"processes\":\"show\"")
  })

  test("falls back to the project grouping when a legacy view is stored", async () => {
    localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
      group: "updated",
      processes: "show",
      status: [],
      environment: [],
      git: [],
      archived: "active",
    }))

    renderSidebar()

    await waitFor(() => expect(sync.globalSessions.reloadWorkspace).toHaveBeenCalled())
    expect(screen.getByText("Processes")).toBeInTheDocument()
    expect(workspaceHeader("/ws/main")).toBeTruthy()
  })

  test("clicking a process row opens a process tab when one is not already open", async () => {
    renderSidebar()

    await openProcesses()
    await fireEvent.click(screen.getByText("Dev server"))
    expect(claxedo.processPane.setTargetDirectory).toHaveBeenCalledWith("/ws/main")
    expect(groupTabs.g1.addProcess).toHaveBeenCalledWith("/ws/main")
    expect(claxedo.split.setFocus).toHaveBeenCalledWith("g1")
  })

  test("process header add button opens add process dialog", async () => {
    renderSidebar()

    await waitFor(() => expect(screen.getByLabelText("Add process")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Add process"))
    expect(dialogShow).toHaveBeenCalled()
  })

  test("process header action starts only auto-start processes when idle", async () => {
    processState["/ws/main"] = {
      configs: [{ ...cfg("proc-a", "Dev server"), autoStart: true }, { ...cfg("proc-b", "Watcher"), autoStart: false }],
      processes: [],
    }

    renderSidebar()

    await waitFor(() => expect(screen.getByText("Processes")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText("Start auto-start processes")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Start auto-start processes"))
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith("/ws/main", "proc-a", { interactive: true })
    expect(stop).not.toHaveBeenCalled()
  })

  test("process header action stops running processes", async () => {
    renderSidebar()

    await waitFor(() => expect(screen.getByText("Processes")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText("Stop running processes")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Stop running processes"))
    expect(stop).toHaveBeenCalledWith("/ws/main", "proc-a")
  })

  test("clicking a process row focuses an existing process tab for the workspace", async () => {
    groupTabs.g2.items.mockReturnValue([
      tab({ id: "proc-tab", type: "process", title: "Processes", closable: true, directory: "/ws/main" }),
    ])
    claxedo.select.multiPaneLeafView.mockReturnValue([
      {
        id: "leaf-proc-a",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        content: { type: "process", directory: "/ws/main", processId: "proc-a", title: "Dev server" },
        focused: false,
        zoomed: false,
        hidden: false,
        floating: false,
        title: "Dev server",
      },
    ])
    const pane = document.createElement("div")
    pane.setAttribute("data-pane", "leaf-proc-a")
    pane.scrollIntoView = vi.fn()
    document.body.appendChild(pane)

    renderSidebar()

    await openProcesses()
    await fireEvent.click(screen.getByText("Dev server"))
    expect(groupTabs.g2.setActive).toHaveBeenCalledWith("proc-tab")
    await waitFor(() => expect(claxedo.multiPane.focus).toHaveBeenCalledWith("proc-tab", "leaf-proc-a"))
    await waitFor(() => expect(pane.scrollIntoView).toHaveBeenCalled())
    expect(groupTabs.g1.addProcess).not.toHaveBeenCalled()
    expect(claxedo.split.setFocus).toHaveBeenCalledWith("g2")
  })

  test("active process pane keeps the running process row visible", async () => {
    groupTabs.g2.items.mockReturnValue([
      tab({ id: "proc-tab", type: "process", title: "Processes", closable: true, directory: "/ws/main" }),
    ])
    groupTabs.g2.activeId.mockReturnValue("proc-tab")

    renderSidebar()

    await waitFor(() => expect(screen.getByText("Dev server")).toBeInTheDocument())
    expect(screen.getByText("Dev server").closest("[data-status]")).toHaveAttribute("data-status", "running")
  })

  test("updates process rows from SSE config changes", async () => {
    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByText("Dev server")).toBeInTheDocument())
    emit("/ws/main", {
      type: "process.config.changed",
      properties: {
        configs: [
          cfg("proc-b", "API watcher"),
        ],
      },
    })
    await waitFor(() => expect(screen.getByText("API watcher")).toBeInTheDocument())
    expect(screen.queryByText("Dev server")).not.toBeInTheDocument()
  })

  test("reloads process state after a crash event so conflict details can hydrate", async () => {
    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByText("Dev server")).toBeInTheDocument())
    list.mockClear()
    emit("/ws/main", {
      type: "process.crashed",
      properties: {
        configId: "proc-a",
        exitCode: 1,
        restartCount: 0,
      },
    })
    await waitFor(() => expect(list).toHaveBeenCalledWith("/ws/main"))
  })

  test("keeps stopped process rows stopped when a stale stopping event arrives later", async () => {
    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByText("Dev server")).toBeInTheDocument())
    emit("/ws/main", {
      type: "process.stopped",
      properties: {
        configId: "proc-a",
        exitCode: 0,
      },
    })
    await waitFor(() => expect(screen.getByText("Dev server").closest("[data-status]")).toHaveAttribute("data-status", "stopped"))
    emit("/ws/main", {
      type: "process.status",
      properties: {
        configId: "proc-a",
        status: "stopping",
      },
    })
    expect(screen.getByText("Dev server").closest("[data-status]")).toHaveAttribute("data-status", "stopped")
  })

  test("shows row-level health for running and crashed processes", async () => {
    processState["/ws/main"] = {
      configs: [{ ...cfg("proc-a", "Dev server") }, { ...cfg("proc-b", "Watcher") }],
      processes: [proc("proc-a", "running"), proc("proc-b", "crashed")],
    }

    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByText("Dev server")).toBeInTheDocument())
    const ok = screen.getByText("Dev server").closest("[data-status]")
    const bad = screen.getByText("Watcher").closest("[data-status]")
    expect(ok).toHaveAttribute("data-status", "running")
    expect(bad).toHaveAttribute("data-status", "crashed")
  })

  test("row hover action starts a stopped process", async () => {
    processState["/ws/main"] = {
      configs: [{ ...cfg("proc-a", "Dev server") }],
      processes: [proc("proc-a", "stopped")],
    }

    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByLabelText("Start process: Dev server")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Start process: Dev server"))
    expect(start).toHaveBeenCalledWith("/ws/main", "proc-a", { interactive: true })
  })

  test("row hover action stops a running process", async () => {
    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByLabelText("Stop process: Dev server")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Stop process: Dev server"))
    expect(stop).toHaveBeenCalledWith("/ws/main", "proc-a")
  })

  test("row hover action restarts a crashed process", async () => {
    processState["/ws/main"] = {
      configs: [{ ...cfg("proc-a", "Dev server") }],
      processes: [proc("proc-a", "crashed")],
    }

    renderSidebar()

    await openProcesses()
    await waitFor(() => expect(screen.getByLabelText("Restart process: Dev server")).toBeInTheDocument())
    await fireEvent.click(screen.getByLabelText("Restart process: Dev server"))
    expect(restart).toHaveBeenCalledWith("/ws/main", "proc-a")
  })
})
