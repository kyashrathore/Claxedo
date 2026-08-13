import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { RailSidebar, SessionListNotice, type ProjectItem } from "./rail-sidebar"

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

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../../features/workspaces/data/workspace-connection", () => ({
  workspacePlacement: () => undefined,
}))

vi.mock("../../../features/settings/ui/terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

vi.mock("../../../features/session/data/sync/session-inventory", () => ({
  useSessionInventoryActions: () => ({
    load: vi.fn(),
    reloadWorkspace: vi.fn(),
    loadMoreProject: vi.fn(),
    loadMoreWorkspace: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
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
  ))
}

describe("RailSidebar disclosure controls", () => {
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
