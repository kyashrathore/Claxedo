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

import { ClaxedoStateProvider, useClaxedoState } from "../state/index"
import { workGraphPanelBodySlot, workGraphPanelHeaderSlot } from "@/ui/controls/portal-slot"
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
  focusPath: () => string | undefined
  focusVersion: () => number | undefined
  /** Acts as the real ReviewWorkspace focus effect acting on the request. */
  consumeFocus: () => void
}

const reviewMounts = vi.hoisted(() => ({ list: [] as unknown[] }))
// Counts constructions of the panel body's per-workspace scope — the subtree a
// retarget tears down and rebuilds (DirectoryScope and every provider under it).
const paneScopeMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock("./rail-sidebar", async () => {
  const actual = await vi.importActual<typeof import("./rail-sidebar")>("./rail-sidebar")
  return { ...actual, RailSidebar: () => <aside data-testid="rail-sidebar" /> }
})

vi.mock("../content/index", () => ({
  ContentRenderer: () => <div data-testid="content-renderer" />,
}))

vi.mock("../../../features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element }) => {
    paneScopeMounts.count += 1
    return <>{props.children}</>
  },
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
    focusPath?: string
    focusVersion?: number
    onFocusConsumed?: () => void
  }) => {
    reviewMounts.list.push({
      initialWorkingSet: props.initialWorkingSet,
      publish: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => props.onWorkingSetChange?.(snapshot),
      focusPath: () => props.focusPath,
      focusVersion: () => props.focusVersion,
      consumeFocus: () => props.onFocusConsumed?.(),
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
  paneScopeMounts.count = 0
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
  review: {
    scroll: { top: 11_200, anchorPath: "src/generated/file-350.ts", anchorOffset: 0 },
    mode: "to-from",
    fromRef: "main",
    toRef: "HEAD",
    diffStyle: "unified",
    openDiffs: ["src/generated/file-350.ts"],
    focusedFile: "src/generated/file-350.ts",
    forcedDiffPaths: ["src/generated/file-350.ts"],
  },
}

// A session in a SECOND workspace, reachable in the same pane. Clicking it is
// the cross-workspace switch: the pane retargets first and the panel follows.
const otherWorkspaceSurface: ContentMeta = {
  id: "surface-other-workspace",
  type: "session",
  scope: "directory",
  directory: "/repo/other",
  sessionId: "ses_other_workspace",
  content: {
    type: "session",
    directory: "/repo/other",
    sessionId: "ses_other_workspace",
    sessionRef: {
      sessionId: "ses_other_workspace",
      host: "workspace",
      cwd: "/repo/other",
      toolSandbox: { kind: "local", cwd: "/repo/other" },
    },
  },
}

function stateWithSurface(meta: ContentMeta, ...rest: ContentMeta[]): ClaxedoState {
  const all = [meta, ...rest]
  return {
    ...emptyClaxedoState(),
    workbench: {
      panes: [{ id: "pane-1", contentId: meta.id }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-1" } },
      contentIds: all.map((entry) => entry.id),
      contentRecency: all.map((entry) => entry.id),
      focusedPaneId: "pane-1",
      layoutSnapshots: {},
    },
    meta: Object.fromEntries(all.map((entry) => [entry.id, entry])),
  }
}

// The WorkGraph global panel is only visible while a WorkGraph surface has
// focus, so the portal test renders on this surface instead of the session one.
const workGraphSurface: ContentMeta = {
  id: "surface-workgraph",
  type: "workgraph",
  scope: "global",
  content: { type: "workgraph", title: "WorkGraph" },
}

function renderRail(focusedSurface: ContentMeta = surface, ...alsoOpen: ContentMeta[]) {
  const queryClient = new QueryClient()
  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  const CaptureState = () => {
    claxedoState = useClaxedoState()
    return null
  }
  const view = render(() => (
    <QueryClientProvider client={queryClient}>
      <SessionTitleProjectionProvider>
        <ClaxedoStateProvider initialState={stateWithSurface(focusedSurface, ...alsoOpen)}>
          <AppShellLayout
            projects={[project]}
            activeProjectId={project.id}
            activeDirectory={project.worktree}
            suppressEmptyDraftSession
          >
            <CaptureState />
          </AppShellLayout>
        </ClaxedoStateProvider>
      </SessionTitleProjectionProvider>
    </QueryClientProvider>
  ))
  return { view, state: () => claxedoState! }
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
    // Budgeted like the cross-workspace case below: this test's own waits allow
    // 10s for the close grace and the rebuild, which the 5s default cannot hold
    // once `turbo test --concurrency=2` is sharing the cores.
  }, 20_000)

  test("recreates the WorkGraph portal slots without duplicates across disposal", async () => {
    const { state } = renderRail(workGraphSurface)
    await waitFor(() => expect(state()).toBeTruthy(), { timeout: 10_000 })

    // Committed global open drives the same shell mount as the WorkGraph toggle.
    state().workspacePanel.openGlobal("workgraph-attention")
    await waitFor(() => expect(screen.getByTestId("workgraph-panel-body-slot")).toBeTruthy())
    expect(screen.getAllByTestId("workgraph-panel-body-slot")).toHaveLength(1)
    expect(workGraphPanelBodySlot()).toBe(screen.getByTestId("workgraph-panel-body-slot"))
    expect(workGraphPanelHeaderSlot()).toBe(screen.getByTestId("workgraph-panel-header-slot"))

    state().workspacePanel.close()
    await waitFor(
      () => expect(screen.queryByTestId("workgraph-panel-body-slot")).toBeNull(),
      { timeout: 10_000 },
    )
    // A disposed shell must not leave a portal target behind: mounting into a
    // stale detached slot would render WorkGraph content into dead DOM.
    expect(workGraphPanelBodySlot()).toBeNull()
    expect(workGraphPanelHeaderSlot()).toBeNull()

    state().workspacePanel.openGlobal("workgraph-attention")
    await waitFor(() => expect(screen.getByTestId("workgraph-panel-body-slot")).toBeTruthy())
    expect(screen.getAllByTestId("workgraph-panel-body-slot")).toHaveLength(1)
    expect(screen.getAllByTestId("workgraph-panel-header-slot")).toHaveLength(1)
    expect(workGraphPanelBodySlot()).toBe(screen.getByTestId("workgraph-panel-body-slot"))
    expect(workGraphPanelHeaderSlot()).toBe(screen.getByTestId("workgraph-panel-header-slot"))
  })

  test("does not replay a consumed focus request over the restored active tab on reopen", async () => {
    const { state } = renderRail()
    await openPanel()

    // The user opens a file from the navigator; the panel delivers the focus
    // request and ReviewWorkspace acts on it.
    state().workspacePanel.retarget({
      workspaceDir: project.worktree,
      targetPaneId: "pane-1",
      focus: { kind: "file", path: "src/a.ts", intent: "tab" },
    })
    await waitFor(() => expect(mounts()[0]!.focusPath()).toBe("src/a.ts"))
    mounts()[0]!.consumeFocus()
    mounts()[0]!.publish(substantialWorkingSet)

    closePanel()
    await waitFor(() => expect(screen.queryByTestId("review-workspace")).toBeNull(), { timeout: 10_000 })
    await openPanel()

    // The slice still carries the old focus across the close, but the new
    // mount restores its active tab from the working set — the stale request
    // must not be delivered again and override it.
    expect(mounts()).toHaveLength(2)
    expect(mounts()[1]!.initialWorkingSet?.activeTabId).toBe(substantialWorkingSet.activeTabId)
    expect(mounts()[1]!.focusPath()).toBeUndefined()
    expect(mounts()[1]!.focusVersion()).toBe(0)

    // The slice's focus version counter restarts once focus is cleared. A
    // brand-new request that happens to reuse the consumed request's version
    // number is NOT a replay and must still be delivered.
    state().workspacePanel.retarget({
      workspaceDir: project.worktree,
      targetPaneId: "pane-1",
      focus: null,
    })
    state().workspacePanel.retarget({
      workspaceDir: project.worktree,
      targetPaneId: "pane-1",
      focus: { kind: "file", path: "src/b.ts", intent: "tab" },
    })
    await waitFor(() => expect(mounts()[1]!.focusPath()).toBe("src/b.ts"))
  })

  test("still delivers a focus request the previous mount never consumed", async () => {
    const { state } = renderRail()
    await openPanel()

    state().workspacePanel.retarget({
      workspaceDir: project.worktree,
      targetPaneId: "pane-1",
      focus: { kind: "file", path: "src/pending.ts", intent: "tab" },
    })
    await waitFor(() => expect(mounts()[0]!.focusPath()).toBe("src/pending.ts"))
    // No consumeFocus(): the request was issued but never acted on (e.g. the
    // lazy Review chunk had not loaded before the user closed the panel).

    closePanel()
    await waitFor(() => expect(screen.queryByTestId("review-workspace")).toBeNull(), { timeout: 10_000 })
    await openPanel()

    expect(mounts()).toHaveLength(2)
    expect(mounts()[1]!.focusPath()).toBe("src/pending.ts")
  })

  test("builds the destination workspace scope exactly once across a cross-workspace switch", async () => {
    const { state } = renderRail(surface, otherWorkspaceSurface)
    await openPanel()
    expect(mounts()).toHaveLength(1)
    const scopesBefore = paneScopeMounts.count

    // The pane moves to the other workspace's session; the panel retargets from
    // the effect that follows and rebuilds its body for /repo/other.
    state().wb.navigation.show(otherWorkspaceSurface.id)

    await waitFor(() => expect(mounts()).toHaveLength(2), { timeout: 10_000 })
    await delay(200)
    // Exactly one construction. The outgoing body owns one directory and stops
    // projecting a pane that has left it, so it cannot build the destination
    // scope on its way out and have the panel build it a second time.
    expect(paneScopeMounts.count - scopesBefore).toBe(1)
    expect(mounts()).toHaveLength(2)
    // What "exactly once" leaves standing changed with panel body retention:
    // the outgoing body is KEPT so a switch back is a display flip, so both
    // Review roots are in the document and exactly one of them is the user's.
    // The other sits under a body host the panel has marked inert — which is
    // the whole basis on which retention is allowed (see the panel's
    // `workspace-panel-body` host and the perf harness's retained-inert
    // reader). The closed panel's zero-DOM contract is proved by the disposal
    // tests above and is untouched.
    const reviewRoots = screen.getAllByTestId("review-workspace")
    expect(reviewRoots).toHaveLength(2)
    expect(reviewRoots.filter((root) => !root.closest("[data-panel-body-inert='true']"))).toHaveLength(1)
  }, 20_000)

  test("an inactive retained body does not follow the displayed workspace navigator", async () => {
    const { state } = renderRail(surface, otherWorkspaceSurface)
    await openPanel()

    state().wb.navigation.show(otherWorkspaceSurface.id)
    await waitFor(() => expect(screen.getAllByTestId("review-workspace")).toHaveLength(2), { timeout: 10_000 })

    const inactiveHost = document.querySelector<HTMLElement>(
      "[data-testid='workspace-panel-body'][data-panel-body-inert='true']",
    )
    const displayedHost = document.querySelector<HTMLElement>(
      "[data-testid='workspace-panel-body']:not([data-panel-body-inert])",
    )
    expect(inactiveHost).not.toBeNull()
    expect(displayedHost).not.toBeNull()

    state().workspacePanel.retarget({
      workspaceDir: otherWorkspaceSurface.directory,
      targetPaneId: "pane-1",
      navigator: "processes",
    })

    await waitFor(() =>
      expect(displayedHost!.querySelector("[data-testid='workspace-processes-navigator']")).not.toBeNull()
    )
    expect(inactiveHost!.querySelector("[data-testid='workspace-processes-navigator']")).toBeNull()

    // Returning displays the same retained body and lets it catch up from the
    // authoritative navigator slice; freezing it while inert does not make it
    // stale once it becomes the user's surface again.
    state().wb.navigation.show(surface.id)
    await waitFor(() => expect(inactiveHost).not.toHaveAttribute("data-panel-body-inert"), { timeout: 10_000 })
    await waitFor(() =>
      expect(inactiveHost!.querySelector("[data-testid='workspace-processes-navigator']")).not.toBeNull()
    )
  }, 20_000)

  test("keeps the panel body mounted through a reopen inside the close grace", async () => {
    renderRail()
    await openPanel()
    mounts()[0]!.publish(substantialWorkingSet)

    closePanel()
    await delay(Math.floor(WORKSPACE_PANEL_CLOSE_GRACE_MS / 2))
    await openPanel()

    // Rapid reopen cancels disposal, so the identity is the same mount: no
    // teardown, no reconstruction, no second review root. One workspace was
    // ever displayed, so retention has nothing to hold beside it either.
    expect(mounts()).toHaveLength(1)
    expect(screen.getAllByTestId("review-workspace")).toHaveLength(1)
  })
})
