import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { ClaxedoStateProvider } from "../state"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState, ContentMeta } from "../state/types"
import { setReviewWorkspaceActiveTab } from "../components/review-workspace/review-workspace-active-tab"
import { AppShellLayout } from "../../shell/app-shell-layout"
import type { ProjectItem } from "./domain-types"

vi.mock("./rail-sidebar", async () => {
  const actual = await vi.importActual<typeof import("./rail-sidebar")>("./rail-sidebar")
  return {
    ...actual,
    RailSidebar: () => <aside data-testid="rail-sidebar" />,
  }
})

vi.mock("../content-renderers", () => ({
  ContentRenderer: () => <div data-testid="content-renderer" />,
}))

vi.mock("../components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("../context/process-pane", () => ({
  ProcessPaneProvider: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("../components/review-workspace/review-workspace", () => ({
  ReviewWorkspace: () => <div data-testid="review-workspace" />,
}))

vi.mock("../workspace-panel/workspace-files-navigator", () => ({
  WorkspaceFilesNavigator: () => <div data-testid="workspace-files-navigator" />,
}))

vi.mock("../workspace-panel/workspace-processes-navigator", () => ({
  WorkspaceProcessesNavigator: () => <div data-testid="workspace-processes-navigator" />,
}))

vi.mock("@claxedo/app", () => ({
  getAvatarColors: () => ({ background: "#000", color: "#fff" }),
  useCommand: () => ({ register: vi.fn() }),
  usePlatform: () => ({ fetch }),
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
  useOptionalTerminal: () => ({ close: vi.fn() }),
}))

vi.mock("@/context/permission", () => ({
  usePermission: () => ({ autoResponds: () => false }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../shell/workspace/workspace-connection", () => ({
  isWorkspaceReady: () => true,
  workspaceOffline: () => undefined,
  workspacePlacement: () => undefined,
}))

vi.mock("../../components/settings/terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

afterEach(() => {
  setReviewWorkspaceActiveTab(undefined)
  cleanup()
})

const project = {
  id: "project-1",
  worktree: "/repo/main",
  name: "Main",
} satisfies ProjectItem

function stateWithSurface(surface: ContentMeta): ClaxedoState {
  return {
    ...emptyClaxedoState(),
    workbench: {
      panes: [{ id: "pane-1", contentId: surface.id }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-1" } },
      contentIds: [surface.id],
      contentRecency: [surface.id],
      focusedPaneId: "pane-1",
      layoutSnapshots: {},
    },
    meta: {
      [surface.id]: surface,
    },
  }
}

function renderRail(surface: ContentMeta) {
  const queryClient = new QueryClient()
  return render(() => (
    <QueryClientProvider client={queryClient}>
      <ClaxedoStateProvider initialState={stateWithSurface(surface)}>
        <AppShellLayout
          projects={[project]}
          activeProjectId={project.id}
          activeDirectory={project.worktree}
          suppressEmptyDraftSession
        />
      </ClaxedoStateProvider>
    </QueryClientProvider>
  ))
}

describe("RailLayout workspace tool gates", () => {
  test("does not expose workspace tools for central authz-scoped virtual sessions", async () => {
    renderRail({
      id: "surface-central",
      type: "session",
      scope: "directory",
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
    })

    expect(screen.queryByRole("button", { name: "New Claude Terminal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New Codex Terminal" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Open workspace panel" }))

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open Files" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Open Changes" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Open Processes" })).toBeNull()
    })
  })

  test("exposes workspace tools for workspace-backed sessions", async () => {
    setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
    renderRail({
      id: "surface-workspace",
      type: "session",
      scope: "directory",
      directory: "/repo/main",
      sessionId: "ses_workspace",
      content: {
        type: "session",
        directory: "/repo/main",
        sessionId: "ses_workspace",
        sessionRef: {
          sessionId: "ses_workspace",
          host: "workspace",
          workspaceId: "ws_backed",
          toolSandbox: { kind: "workspace", workspaceId: "ws_backed", hosting: "cloud" },
        },
      },
    })

    expect(screen.getByRole("button", { name: "New Claude Terminal" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "New Codex Terminal" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open workspace panel" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open Files" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Changes" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Processes" })).toBeTruthy()
    })
  })

  test("exposes workspace tools for local-backed sessions", async () => {
    setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
    renderRail({
      id: "surface-local",
      type: "session",
      scope: "directory",
      directory: "/repo/main",
      sessionId: "ses_local",
      content: {
        type: "session",
        directory: "/repo/main",
        sessionId: "ses_local",
        sessionRef: {
          sessionId: "ses_local",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      },
    })

    expect(screen.getByRole("button", { name: "New Claude Terminal" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "New Codex Terminal" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open workspace panel" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open Files" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Changes" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Processes" })).toBeTruthy()
    })
  })
})
