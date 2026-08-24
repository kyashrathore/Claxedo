import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { RailSidebar, SessionListNotice, type ProjectItem } from "./rail-sidebar"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { dispatchSessionStatusEvent } from "@/features/session/store/session-status-dispatcher"
import type { SessionNavigationRow } from "@/features/session/ui/navigation/session-navigation"

const inventoryMocks = vi.hoisted(() => ({
  reloadWorkspace: vi.fn(),
}))
const sessionListMocks = vi.hoisted(() => ({
  items: [] as SessionNavigationRow[],
  request: vi.fn(async (query: { scope: string; groupBy?: string; limit?: number }) => ({
    view: {
      scope: query.scope,
      groupBy: query.groupBy ?? "none",
      sort: "updated_desc",
      limit: query.limit ?? 50,
    },
    items: sessionListMocks.items,
  })),
}))
const railRuntimeMocks = vi.hoisted(() => ({
  statusByDirectory: {} as Record<string, Record<string, { type: "idle" | "busy" }>>,
  failingDirectories: new Set<string>(),
  createClient: vi.fn((input: { directory: string }) => ({
    session: { status: vi.fn(async () => {
      if (railRuntimeMocks.failingDirectories.has(input.directory)) throw new Error("status unavailable")
      return { data: railRuntimeMocks.statusByDirectory[input.directory] ?? {} }
    }) },
    permission: { list: vi.fn(async () => ({ data: [] })) },
    question: { list: vi.fn(async () => ({ data: [] })) },
  })),
}))

// rail-sidebar imports these from their owner modules, not the entry barrel;
// the old "@claxedo/app" mock stopped covering anything when the imports moved
// (masked until the branch's broken renderer-trace import was fixed and this
// file could load again).
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/app/connection/server", () => ({
  useServer: () => ({ isLocal: () => true }),
}))

vi.mock("@/platform/account/account-provider", () => ({
  useAccountPort: () => ({
    state: () => ({ status: "signed-out" }),
    signIn: async () => undefined,
    signOut: async () => undefined,
    run: async () => undefined,
  }),
  AccountPortProvider: (props: { children: unknown }) => props.children,
}))

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:4096",
    createClient: railRuntimeMocks.createClient,
    client: {
      session: { status: vi.fn(), requests: vi.fn() },
      permission: { list: vi.fn() },
      question: { list: vi.fn() },
    },
  }),
}))

vi.mock("@/features/terminal/providers/provider", () => ({
  useOptionalTerminal: () => ({ all: () => [], close: vi.fn() }),
}))

vi.mock("@/features/session/providers/permission", () => ({
  usePermission: () => ({ autoResponds: () => false }),
}))

vi.mock("@/features/session/ui/navigation/session-navigation-list", () => ({
  SessionNavigation: (props: { rows: Array<{ source: { sessionId: string }; status: string }> }) => (
    <div
      data-testid="mock-session-navigation"
      data-session-count={props.rows.length}
      data-session-statuses={props.rows.map((row) => `${row.source.sessionId}:${row.status}`).join(",")}
    />
  ),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../../features/workspaces/data/workspace-connection", () => ({
  isWorkspaceReady: () => true,
  workspacePlacement: () => undefined,
}))

vi.mock("../../../features/settings/ui/terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

vi.mock("../../../features/session/data/sync/session-inventory", () => ({
  useSessionInventoryActions: () => ({
    load: vi.fn(),
    reloadWorkspace: inventoryMocks.reloadWorkspace,
    loadMoreProject: vi.fn(),
    loadMoreWorkspace: vi.fn(),
  }),
}))

vi.mock("../../../features/session/data/query/session-list", () => ({
  sessionListQueryOptions: (input: { query: { scope: string; groupBy?: string; limit?: number } }) => ({
    queryKey: ["test-session-list", JSON.stringify(input.query)],
    queryFn: () => sessionListMocks.request(input.query),
  }),
  appendSessionListPageQueryData: (input: { page: unknown }) => input.page,
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  inventoryMocks.reloadWorkspace.mockClear()
  sessionListMocks.request.mockClear()
  sessionListMocks.items = []
  railRuntimeMocks.createClient.mockClear()
  railRuntimeMocks.statusByDirectory = {}
  railRuntimeMocks.failingDirectories.clear()
})

const project = {
  id: "project-1",
  worktree: "/repo/main",
  name: "Main",
  workspaces: {
    "/repo/main": {
      id: "/repo/main",
      directory: "/repo/main",
      kind: "local",
    },
  },
} satisfies ProjectItem

const twoWorkspaceProject = {
  ...project,
  workspaces: {
    "/repo/main": {
      id: "/repo/main",
      directory: "/repo/main",
      kind: "local",
    },
    "/repo/secondary": {
      id: "/repo/secondary",
      directory: "/repo/secondary",
      kind: "local",
    },
  },
} satisfies ProjectItem

// `RailSidebar` renders `GlobalNavigation`, which reads `useLocation()` to mark
// the active surface. That is a Route-scoped primitive, so the sidebar only
// mounts inside a router — as it does in the app shell.
function renderInRouter(component: () => JSX.Element) {
  return render(() => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Route path="*" component={component} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function renderSidebar(input?: {
  group?: "project" | "workspace"
  railDocked?: boolean
  onToggleSidebar?: ReturnType<typeof vi.fn>
  onWorkspaceSelect?: ReturnType<typeof vi.fn>
}) {
  if (input?.group) {
    localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
      group: input.group,
      status: [],
      environment: [],
      git: [],
      archived: "active",
    }))
  }

  renderInRouter(() => (
    <SessionTitleProjectionProvider>
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
          projects={[project]}
          onWorkspaceSelect={input?.onWorkspaceSelect}
          onRailCancelCollapse={() => undefined}
          onRailLockChange={() => undefined}
          onRailMouseLeave={() => undefined}
          onRailTrackPosition={() => undefined}
          onToggleSidebar={input?.onToggleSidebar ?? (() => undefined)}
          railDocked={input?.railDocked ?? true}
          railExpanded
          railWidth={260}
        />
      </ClaxedoStateProvider>
    </SessionTitleProjectionProvider>
  ))
}

describe("RailSidebar disclosure controls", () => {
  test("leaves canonical inventory ownership outside the rail across focus changes", async () => {
    const [activeSessionId, setActiveSessionId] = createSignal("ses_1")
    const [activeDirectory, setActiveDirectory] = createSignal("/repo/main")
    renderInRouter(() => (
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
          projects={[project]}
          activeSessionId={activeSessionId()}
          activeDirectory={activeDirectory()}
          activeProjectId="project-1"
          onRailCancelCollapse={() => undefined}
          onRailLockChange={() => undefined}
          onRailMouseLeave={() => undefined}
          onRailTrackPosition={() => undefined}
          onToggleSidebar={() => undefined}
          railDocked
          railExpanded
          railWidth={260}
        />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    ))

    await Promise.resolve()
    expect(inventoryMocks.reloadWorkspace).not.toHaveBeenCalled()

    setActiveSessionId("ses_2")
    setActiveDirectory("/repo/another-worktree")

    await Promise.resolve()
    expect(inventoryMocks.reloadWorkspace).not.toHaveBeenCalled()
  })

  test("warm focus changes issue zero session-list requests", async () => {
    localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
      group: "workspace",
      status: [],
      environment: [],
      git: [],
      archived: "active",
    }))
    const [activeSessionId, setActiveSessionId] = createSignal("ses_a")
    const [activeDirectory, setActiveDirectory] = createSignal("/repo/main")
    renderInRouter(() => (
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
          projects={[twoWorkspaceProject]}
          activeSessionId={activeSessionId()}
          activeDirectory={activeDirectory()}
          activeProjectId="project-1"
          onRailCancelCollapse={() => undefined}
          onRailLockChange={() => undefined}
          onRailMouseLeave={() => undefined}
          onRailTrackPosition={() => undefined}
          onToggleSidebar={() => undefined}
          railDocked
          railExpanded
          railWidth={260}
        />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    ))

    await waitFor(() => expect(sessionListMocks.request).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Expand workspace" }))
    await waitFor(() => expect(sessionListMocks.request).toHaveBeenCalledTimes(2))
    const warmedRequests = sessionListMocks.request.mock.calls.length

    setActiveSessionId("ses_b")
    setActiveDirectory("/repo/secondary")
    await Promise.resolve()
    setActiveSessionId("ses_a")
    setActiveDirectory("/repo/main")
    await Promise.resolve()

    expect(sessionListMocks.request).toHaveBeenCalledTimes(warmedRequests)
  })

  test("keeps workspace sections mounted when navigation refreshes project objects", () => {
    localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
      group: "workspace",
      status: [],
      environment: [],
      git: [],
      archived: "active",
    }))
    const [activeSessionId, setActiveSessionId] = createSignal("ses_1")
    renderInRouter(() => (
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
          projects={activeSessionId() ? [{ ...project }] : []}
          activeSessionId={activeSessionId()}
          onRailCancelCollapse={() => undefined}
          onRailLockChange={() => undefined}
          onRailMouseLeave={() => undefined}
          onRailTrackPosition={() => undefined}
          onToggleSidebar={() => undefined}
          railDocked
          railExpanded
          railWidth={260}
        />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    ))
    fireEvent.click(screen.getByRole("button", { name: "Expand project" }))
    const workspaceHeader = screen.getByTestId("workspace-header")

    setActiveSessionId("ses_2")

    expect(screen.getByTestId("workspace-header")).toBe(workspaceHeader)
  })

  test("shows the sidebar toggle while docked", () => {
    const onToggleSidebar = vi.fn()
    renderSidebar({ onToggleSidebar })

    fireEvent.click(screen.getByRole("button", { name: "Hide Sidebar" }))

    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })

  test("hides the sidebar toggle while floating open", () => {
    renderSidebar({ railDocked: false })

    expect(screen.queryByRole("button", { name: "Hide Sidebar" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Dock Sidebar" })).toBeNull()
  })

  test("project chevron is focusable and toggles with Enter", () => {
    const onWorkspaceSelect = vi.fn()
    renderSidebar({ group: "project", onWorkspaceSelect })

    const expand = screen.getByRole("button", { name: "Expand project" })
    expect(expand.tabIndex).toBe(0)
    expect(expand).toHaveAttribute("aria-expanded", "false")

    fireEvent.keyDown(expand, { key: "Enter" })

    const collapse = screen.getByRole("button", { name: "Collapse project" })
    expect(collapse).toHaveAttribute("aria-expanded", "true")
    expect(onWorkspaceSelect).not.toHaveBeenCalled()
  })

  test("workspace group project chevron toggles with Space without selecting the project", () => {
    const onWorkspaceSelect = vi.fn()
    renderSidebar({ group: "workspace", onWorkspaceSelect })

    const expand = screen.getByRole("button", { name: "Expand project" })
    expect(expand.tabIndex).toBe(0)
    expect(expand).toHaveAttribute("aria-expanded", "false")

    fireEvent.keyDown(expand, { key: " " })

    const collapse = screen.getByRole("button", { name: "Collapse project" })
    expect(collapse).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("workspace-header")).toBeInTheDocument()
    expect(onWorkspaceSelect).not.toHaveBeenCalled()
  })

  test("workspace chevron is focusable and toggles with Enter without selecting the workspace", () => {
    const onWorkspaceSelect = vi.fn()
    renderSidebar({ group: "workspace", onWorkspaceSelect })
    fireEvent.keyDown(screen.getByRole("button", { name: "Expand project" }), { key: "Enter" })

    const expand = screen.getByRole("button", { name: "Expand workspace" })
    expect(expand.tabIndex).toBe(0)
    expect(expand).toHaveAttribute("aria-expanded", "false")

    fireEvent.keyDown(expand, { key: "Enter" })

    expect(screen.getByRole("button", { name: "Collapse workspace" })).toHaveAttribute("aria-expanded", "true")
    expect(onWorkspaceSelect).not.toHaveBeenCalled()
  })

  test("activity refetches every open placement group and collapsed sections unregister it", async () => {
    sessionListMocks.items = [{
      type: "session",
      sessionRef: "local:/repo/main:session:shared",
      sessionId: "shared",
      title: "Shared session",
      directory: "/repo/main",
      projectId: "project-1",
      createdAt: 1,
      updatedAt: 2,
      tags: [],
      attachments: [],
    }]
    renderSidebar({ group: "project" })

    fireEvent.click(screen.getByRole("button", { name: "Expand project" }))
    await waitFor(() => expect(railRuntimeMocks.createClient).toHaveBeenCalledTimes(1))

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "shared", status: { type: "busy" } },
    })
    await waitFor(() => expect(railRuntimeMocks.createClient).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole("button", { name: "Collapse project" }))
    const callsAfterCollapse = railRuntimeMocks.createClient.mock.calls.length
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "shared", status: { type: "idle" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(railRuntimeMocks.createClient).toHaveBeenCalledTimes(callsAfterCollapse)
  })

  test("an ambiguous id event never projects one placement into another when a refetch fails", async () => {
    sessionListMocks.items = [
      {
        type: "session",
        sessionRef: "local:/repo/main:session:duplicate",
        sessionId: "duplicate",
        title: "Main shared session",
        directory: "/repo/main",
        projectId: "project-1",
        createdAt: 1,
        updatedAt: 3,
        tags: [],
        attachments: [],
      },
      {
        type: "session",
        sessionRef: "local:/repo/secondary:session:duplicate",
        sessionId: "duplicate",
        title: "Secondary shared session",
        directory: "/repo/secondary",
        projectId: "project-1",
        createdAt: 1,
        updatedAt: 2,
        tags: [],
        attachments: [],
      },
    ]
    railRuntimeMocks.statusByDirectory = {
      "/repo/main": { duplicate: { type: "busy" } },
      "/repo/secondary": { duplicate: { type: "busy" } },
    }

    renderSidebar({ group: "project" })
    fireEvent.click(screen.getByRole("button", { name: "Expand project" }))

    const navigation = await screen.findByTestId("mock-session-navigation")
    await waitFor(() => expect(navigation).toHaveAttribute(
      "data-session-statuses",
      "duplicate:working,duplicate:working",
    ))

    railRuntimeMocks.failingDirectories.add("/repo/secondary")
    const callsBeforeEvent = railRuntimeMocks.createClient.mock.calls.length

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "duplicate", status: { type: "idle" } },
    })
    await waitFor(() => expect(railRuntimeMocks.createClient.mock.calls.length).toBe(callsBeforeEvent + 2))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The successful placement remains busy and the failed placement retains
    // its last authoritative local value. Neither consumes the ambiguous id.
    expect(navigation).toHaveAttribute("data-session-statuses", "duplicate:working,duplicate:working")
  })
})

describe("SessionListNotice variant styling", () => {
  afterEach(() => cleanup())

  test("error variant renders a critical glyph and testid the loading variant lacks", () => {
    render(() => <SessionListNotice variant="error">Could not load sessions.</SessionListNotice>)

    const notice = screen.getByTestId("rail-sidebar-session-list-error")
    // Named, not sprite-indexed: `SessionListNotice` renders `ClaxedoIcon`, whose
    // `use` href follows whichever library `iconLibrary()` is on (codex by
    // default since 5197e0704). Which glyph each name maps to is pinned in
    // `ui/controls/claxedo-icon.vitest.tsx`; what this owns is that the error
    // variant draws the `warning` mark in the critical colour.
    const glyph = notice.querySelector('[data-component="icon"][data-icon="warning"]')
    expect(glyph).not.toBeNull()
    expect(glyph?.querySelector("use")).not.toBeNull()
    expect(notice.querySelector('[data-slot="icon-svg"]')).toHaveClass("text-icon-critical-base")
  })

  test("loading variant renders no critical glyph", () => {
    render(() => <SessionListNotice variant="loading">Loading sessions...</SessionListNotice>)

    const notice = screen.getByTestId("rail-sidebar-session-list-loading")
    expect(notice.querySelector('[data-icon="warning"]')).toBeNull()
    expect(notice.querySelector('[data-component="icon"]')).toBeNull()
  })
})
