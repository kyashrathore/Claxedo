import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ClaxedoStateProvider } from "../state"
import { emptyClaxedoState } from "../state/persistence"
import { RailSidebar, type ProjectItem } from "./rail-sidebar"

vi.mock("@opencode-ai/claxedo-app", () => ({
  getAvatarColors: () => ({ background: "#000", color: "#fff" }),
  useLanguage: () => ({ t: (key: string) => key }),
  useServer: () => ({ isLocal: () => true }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:4096",
    client: {
      session: { status: vi.fn(), requests: vi.fn() },
      permission: { list: vi.fn() },
      question: { list: vi.fn() },
    },
  }),
}))

vi.mock("@/context/terminal", () => ({
  useOptionalTerminal: () => ({ all: () => [], close: vi.fn() }),
}))

vi.mock("@/context/permission", () => ({
  usePermission: () => ({ autoResponds: () => false }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../shell/workspace/workspace-connection", () => ({
  workspacePlacement: () => undefined,
}))

vi.mock("../../components/settings-terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

vi.mock("../../shell/data/session-inventory", () => ({
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

function renderSidebar(input?: { group?: "project" | "workspace"; onWorkspaceSelect?: ReturnType<typeof vi.fn> }) {
  if (input?.group) {
    localStorage.setItem("claxedo.session-view.v1", JSON.stringify({
      group: input.group,
      status: [],
      environment: [],
      git: [],
      archived: "active",
    }))
  }

  render(() => (
    <QueryClientProvider client={new QueryClient()}>
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <RailSidebar
          projects={[project]}
          onWorkspaceSelect={input?.onWorkspaceSelect}
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
    </QueryClientProvider>
  ))
}

describe("RailSidebar disclosure controls", () => {
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
