import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState, ContentMeta } from "../state/types"
import {
  setReviewWorkspaceActiveTab,
  type ReviewWorkspaceActiveTab,
} from "@/features/review/ui/review-workspace-active-tab"
import { AppShellLayout } from "../../app-shell-layout"
import type { ProjectItem } from "./domain-types"

vi.mock("./rail-sidebar", async () => {
  const actual = await vi.importActual<typeof import("./rail-sidebar")>("./rail-sidebar")
  return {
    ...actual,
    RailSidebar: () => <aside data-testid="rail-sidebar" />,
  }
})

vi.mock("../content/index", () => ({
  ContentRenderer: () => <div data-testid="content-renderer" />,
}))

vi.mock("../../../features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("../context/process-pane", () => ({
  ProcessPaneProvider: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("@/app/workbench/review/review-workspace", () => ({
  ReviewWorkspace: () => <div data-testid="review-workspace" />,
}))

vi.mock("../workspace-panel/files-navigator", () => ({
  WorkspaceFilesNavigator: () => <div data-testid="workspace-files-navigator" />,
}))

vi.mock("@/features/processes/ui", () => ({
  WorkspaceProcessesNavigator: () => <div data-testid="workspace-processes-navigator" />,
}))

vi.mock("@claxedo/app", () => ({
  getAvatarColors: () => ({ background: "#000", color: "#fff" }),
  useCommand: () => ({ register: vi.fn() }),
  usePlatform: () => ({ fetch }),
  useServer: () => ({ isLocal: () => true }),
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
  useOptionalTerminal: () => ({ close: vi.fn() }),
}))

vi.mock("@/features/session/providers/permission", () => ({
  usePermission: () => ({ autoResponds: () => false }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("../../../features/workspaces/data/workspace-connection", () => ({
  isWorkspaceReady: () => true,
  workspaceOffline: () => undefined,
  workspacePlacement: () => undefined,
}))

vi.mock("../../../features/settings/ui/terminals", () => ({
  getTerminalCommands: () => ({ claude: "claude", codex: "codex", custom: [] }),
}))

vi.mock("@/platform/settings/provider", () => ({
  useSettings: () => ({ appearance: { navigatorSide: () => "right" } }),
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

    // The header's terminal control is role-gated, not surface-gated, so it is
    // present on every surface including this one. It used to be a pair of
    // per-agent shortcuts ("New Claude Terminal" / "New Codex Terminal"); 73d56ab29
    // replaced them with one button that opens the creator, because the header's
    // directory is an inferred fallback chain rather than a choice. The surface
    // gate this file is about is the Files/Changes/Processes trio below.
    expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy()

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

    expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy()

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

    expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open workspace panel" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open Files" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Changes" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Open Processes" })).toBeTruthy()
    })
  })

  test("keeps all workspace tools visible across review workspace tabs", async () => {
    setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
    renderRail({
      id: "surface-tabs",
      type: "session",
      scope: "directory",
      directory: "/repo/main",
      sessionId: "ses_tabs",
      content: {
        type: "session",
        directory: "/repo/main",
        sessionId: "ses_tabs",
        sessionRef: {
          sessionId: "ses_tabs",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      },
    })

    fireEvent.click(screen.getByRole("button", { name: "Open workspace panel" }))

    const tabs = [
      { kind: "review", label: "Review" },
      { kind: "file", label: "README.md", path: "README.md" },
      { kind: "browser", label: "Browser" },
      { kind: "context", label: "Context" },
      { kind: "process", label: "Dev server" },
    ] satisfies ReviewWorkspaceActiveTab[]

    for (const tab of tabs) {
      setReviewWorkspaceActiveTab(tab)
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Open Files" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Open Changes" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Open Processes" })).toBeTruthy()
      })
    }
  })
})
