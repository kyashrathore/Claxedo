/**
 * Closed-Workspace disposal contract, at the real panel boundary.
 *
 * The panel body is unmounted once the close motion plus its grace has run, so a
 * closed Workspace owns no DOM and no CPU. Everything the user expects back on
 * reopen therefore has to live OUTSIDE that DOM: the Review working set is held
 * by the workspace-panel slice on the provider (see `createWorkspacePanelSlice`)
 * and handed to the next mount as `initialWorkingSet`.
 *
 * These tests drive the same `AppShellLayout` a user does — open, close, wait
 * past the grace, reopen — rather than calling the motion state directly, which
 * is what `workspace-panel-motion-state.test.ts` already covers.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"

import { ClaxedoStateProvider } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState, ContentMeta } from "../state/types"
import { setReviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { WORKSPACE_PANEL_CLOSE_GRACE_MS } from "@/features/workspaces/ui/panel/workspace-panel-lifecycle"
import type { ReviewWorkspaceWorkingSetSnapshot } from "../review/review-workspace-working-set"
import { AppShellLayout } from "../../app-shell-layout"
import type { ProjectItem } from "./domain-types"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"

type ReviewMount = {
  initialWorkingSet?: ReviewWorkspaceWorkingSetSnapshot
  publish: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => void
}

const reviewMounts = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock("./rail-sidebar", async () => {
  const actual = await vi.importActual<typeof import("./rail-sidebar")>("./rail-sidebar")
  return { ...actual, RailSidebar: () => <aside data-testid="rail-sidebar" /> }
})

vi.mock("../content/index", () => ({
  ContentRenderer: () => <div data-testid="content-renderer" />,
}))

vi.mock("../../../features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("../context/process-pane", () => ({
  ProcessPaneProvider: (props: { children: JSX.Element }) => <>{props.children}</>,
  useProcessPane: () => ({}),
}))

// Stands in for the real ReviewWorkspace: records the working set each mount was
// handed, and exposes its publish callback so a test can act as the user
// building up tabs and scrolling Review.
vi.mock("@/app/workbench/review/review-workspace", () => ({
  ReviewWorkspace: (props: {
    initialWorkingSet?: ReviewWorkspaceWorkingSetSnapshot
    onWorkingSetChange?: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => void
  }) => {
    reviewMounts.list.push({
      initialWorkingSet: props.initialWorkingSet,
      publish: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => props.onWorkingSetChange?.(snapshot),
    })
    return <div data-testid="review-workspace" />
  },
}))

vi.mock("../workspace-panel/files-navigator", () => ({
  WorkspaceFilesNavigator: () => <div data-testid="workspace-files-navigator" />,
}))

vi.mock("@/features/processes/ui", () => ({
  WorkspaceProcessesNavigator: () => <div data-testid="workspace-processes-navigator" />,
}))

vi.mock("@/app/providers/command", async () => {
  const actual = await vi.importActual<typeof import("../../providers/command")>("@/app/providers/command")
  return { ...actual, useCommand: () => ({ register: vi.fn() }) }
})

vi.mock("@/app/connection/server", async () => {
  const actual = await vi.importActual<typeof import("../../connection/server")>("@/app/connection/server")
  return { ...actual, useServer: () => ({ isLocal: () => true }) }
})

vi.mock("@/platform/runtime/platform-provider", async () => {
  const actual = await vi.importActual<typeof import("../../../platform/runtime/platform-provider")>(
    "@/platform/runtime/platform-provider",
  )
  return { ...actual, usePlatform: () => ({ fetch }) }
})

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

beforeEach(() => {
  reviewMounts.list = []
  setReviewWorkspaceActiveTab({ kind: "review", label: "Review" })
})

afterEach(() => {
  setReviewWorkspaceActiveTab(undefined)
  cleanup()
})

const project = { id: "project-1", worktree: "/repo/main", name: "Main" } satisfies ProjectItem

const surface: ContentMeta = {
  id: "surface-disposal",
  type: "session",
  scope: "directory",
  directory: "/repo/main",
  sessionId: "ses_disposal",
  content: {
    type: "session",
    directory: "/repo/main",
    sessionId: "ses_disposal",
    sessionRef: {
      sessionId: "ses_disposal",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    },
  },
}

// The exact working set the substantial-workspace scenario restores: three file
// tabs beside Review, a file tab active, and Review parked on its semantic anchor.
const substantialWorkingSet: ReviewWorkspaceWorkingSetSnapshot = {
  tabs: [
    { id: "review", kind: "review" },
    { id: "file:src/generated/file-1.ts", kind: "file", tabId: "file:src/generated/file-1.ts" },
    { id: "file:src/generated/file-2.ts", kind: "file", tabId: "file:src/generated/file-2.ts" },
    { id: "file:src/generated/file-3.ts", kind: "file", tabId: "file:src/generated/file-3.ts" },
  ],
  activeTabId: "file:src/generated/file-2.ts",
  review: { scroll: { top: 11_200, anchorPath: "src/generated/file-350.ts", anchorOffset: 0 } },
}

function stateWithSurface(meta: ContentMeta): ClaxedoState {
  return {
    ...emptyClaxedoState(),
    workbench: {
      panes: [{ id: "pane-1", contentId: meta.id }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-1" } },
      contentIds: [meta.id],
      contentRecency: [meta.id],
      focusedPaneId: "pane-1",
      layoutSnapshots: {},
    },
    meta: { [meta.id]: meta },
  }
}

function renderRail() {
  const queryClient = new QueryClient()
  return render(() => (
    <QueryClientProvider client={queryClient}>
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={stateWithSurface(surface)}>
          <AppShellLayout
            projects={[project]}
            activeProjectId={project.id}
            activeDirectory={project.worktree}
            suppressEmptyDraftSession
          />
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    </QueryClientProvider>
  ))
}

function mounts() {
  return reviewMounts.list as ReviewMount[]
}

async function openPanel() {
  fireEvent.click(await screen.findByRole("button", { name: "Open workspace panel" }, { timeout: 10_000 }))
  return screen.findByTestId("review-workspace", {}, { timeout: 10_000 })
}

function closePanel() {
  // Two toggles carry this label while the panel is open (the floating chrome
  // and the panel header); either drives the same close.
  fireEvent.click(screen.getAllByRole("button", { name: "Close workspace panel" })[0]!)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe("closed workspace disposal and reconstruction", () => {
  test("unmounts the panel body after the close grace and rebuilds it from the retained working set", async () => {
    renderRail()
    await openPanel()

    expect(mounts()).toHaveLength(1)
    expect(mounts()[0]!.initialWorkingSet).toBeUndefined()
    mounts()[0]!.publish(substantialWorkingSet)

    closePanel()
    await waitFor(
      () => {
        expect(screen.queryByTestId("review-workspace")).toBeNull()
        expect(screen.queryByTestId("workspace-navigator-overlay")).toBeNull()
      },
      { timeout: 10_000 },
    )

    await openPanel()
    expect(mounts()).toHaveLength(2)
    // A disposed panel owns nothing, so this is a genuinely new mount — and it
    // still comes back on the user's exact tabs, active tab, and Review scroll.
    expect(mounts()[1]!.initialWorkingSet).toEqual(substantialWorkingSet)
    expect(screen.getAllByTestId("review-workspace")).toHaveLength(1)
  })

  test("keeps the panel body mounted through a reopen inside the close grace", async () => {
    renderRail()
    await openPanel()
    mounts()[0]!.publish(substantialWorkingSet)

    closePanel()
    await delay(Math.floor(WORKSPACE_PANEL_CLOSE_GRACE_MS / 2))
    await openPanel()

    // Rapid reopen cancels disposal, so the identity is the same mount: no
    // teardown, no reconstruction, no second review root.
    expect(mounts()).toHaveLength(1)
    expect(screen.getAllByTestId("review-workspace")).toHaveLength(1)
  })
})
