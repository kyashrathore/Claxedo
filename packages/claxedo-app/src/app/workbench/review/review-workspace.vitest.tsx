/**
 * ReviewWorkspace inner-tab lifecycle, at the real component boundary.
 *
 * Three contracts under test, all against the actual ReviewWorkspace with only
 * its heavy leaves mocked:
 *
 *  - Activation is last-interaction-wins: a tab insertion defers its
 *    activation by one frame, and a direct tab click landing inside that frame
 *    must not be overwritten when the frame fires.
 *  - The Review surface is RETAINED while another workspace tab is active: its
 *    DOM, viewport binding and observer stay, the surface is marked inert, and
 *    the binding still dies with the surface's DOM when the workspace itself is
 *    disposed.
 *  - Returning to Review shows the live surface, and the working-set boundary
 *    keeps holding what that surface published — which is what a real remount
 *    (a panel reopen) would restore from.
 */
import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { flush, type JSX } from "solid-js"

import { ReviewWorkspace } from "./review-workspace"
import { REVIEW_SCROLL_DIAGNOSTIC_PROPERTY } from "./review-scroll-restoration"
import type { ReviewWorkspaceWorkingSetSnapshot } from "./review-workspace-working-set"

type ReviewTabMount = {
  retained: Record<string, unknown> | undefined
  viewport: HTMLDivElement | undefined
  publishSurface: (surface: Record<string, unknown>) => void
}

const reviewTabMounts = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock("@/features/review/ui/review-tab", () => ({
  ReviewTab: (props: {
    retained?: Record<string, unknown>
    onRetainedChange?: (surface: Record<string, unknown>) => void
    scrollRef?: (element: HTMLDivElement) => void
  }) => {
    const mount: ReviewTabMount = {
      // The real ReviewTab reads `retained` once at setup — mirror that.
      retained: props.retained,
      viewport: undefined,
      publishSurface: (surface) => props.onRetainedChange?.(surface),
    }
    reviewTabMounts.list.push(mount)
    return (
      <div
        data-testid="mock-review-viewport"
        ref={(element) => {
          mount.viewport = element
          props.scrollRef?.(element)
        }}
      />
    )
  },
}))

vi.mock("@/app/providers/file", () => ({
  useFile: () => ({
    tab: (path: string) => `file:${path}`,
    pathFromTab: (tabId: string) => (tabId.startsWith("file:") ? tabId.slice("file:".length) : undefined),
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))

vi.mock("@/app/workbench/context/process-pane", () => ({
  useProcessPane: () => ({ configs: () => [] }),
}))

vi.mock("@/app/workbench/state", () => ({
  useClaxedoState: () => ({
    layout: { openPage: vi.fn() },
    workspacePanel: { close: vi.fn() },
  }),
}))

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({ event: { listen: () => () => {} } }),
}))

vi.mock("@tanstack/solid-query", () => ({
  useQuery: () => ({ data: undefined }),
  // The workspace's anchorExists predicate imports the review vcs cache,
  // which constructs the app QueryClient at module scope.
  QueryClient: class {
    getQueryData() {
      return undefined
    }
  },
}))

vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({ projects: () => ({}) }),
}))

vi.mock("@/features/session/providers/prompt", () => ({
  PromptProvider: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("@/features/session/providers/session-params", () => ({
  SessionParamsProvider: (props: { children: JSX.Element }) => <>{props.children}</>,
}))

vi.mock("@/features/session/ui/components/session-context-tab", () => ({
  SessionContextTab: () => <div data-testid="mock-context-tab" />,
}))

vi.mock("@/features/session/ui/dialogs/select-file", () => ({
  DialogSelectFile: () => null,
}))

vi.mock("@/app/workbench/workspace-panel/browser-panel", () => ({
  WorkspaceBrowserPanel: () => <div data-testid="mock-browser-panel" />,
}))

vi.mock("@/app/workbench/content/tab-file", () => ({
  isMarkdownPath: () => false,
  TabFile: (props: { path: string }) => <div data-testid="mock-tab-file" data-path={props.path} />,
}))

vi.mock("./review-workspace-process-section", () => ({
  ReviewWorkspaceProcessSection: () => <div data-testid="mock-process-section" />,
}))

vi.mock("@/features/documents/data/documents-api", () => ({
  documentsApi: {},
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: vi.fn(),
}))

vi.mock("@/ui/controls/claxedo-icon", () => ({
  ClaxedoIcon: () => <span data-testid="mock-icon" />,
}))

vi.mock("@/ui/controls/claxedo-icon-button", () => ({
  ClaxedoIconButton: (props: { "aria-label"?: string; onClick?: (event: MouseEvent) => void }) => (
    <button type="button" aria-label={props["aria-label"]} onClick={(event) => props.onClick?.(event)} />
  ),
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const DropdownMenu = Object.assign((props: { children: JSX.Element }) => <div>{props.children}</div>, {
    Trigger: (props: { children: JSX.Element }) => <button type="button">{props.children}</button>,
    Portal: (props: { children: JSX.Element }) => <>{props.children}</>,
    Content: (props: { children: JSX.Element }) => <div>{props.children}</div>,
    Item: (props: { children: JSX.Element }) => <div>{props.children}</div>,
  })
  return { DropdownMenu }
})

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(_callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(element: Element) {
    this.observed.push(element)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}

let frameQueue: Array<FrameRequestCallback | undefined>

function flushFrames() {
  // Frames queued while flushing belong to the next flush.
  const pending = frameQueue
  frameQueue = []
  for (const callback of pending) callback?.(0)
  // Solid 2 stages writes until a flush; the browser reaches its microtask
  // checkpoint between a frame callback and paint, so a frame's writes are
  // applied by the time anything can observe the DOM.
  flush()
}

beforeEach(() => {
  reviewTabMounts.list = []
  FakeResizeObserver.instances = []
  frameQueue = []
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameQueue.push(callback)
    return frameQueue.length
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameQueue[id - 1] = undefined
  })
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mounts() {
  return reviewTabMounts.list as ReviewTabMount[]
}

const workingSetWithFileTab: ReviewWorkspaceWorkingSetSnapshot = {
  tabs: [
    { id: "review", kind: "review" },
    { id: "file:src/a.ts", kind: "file", tabId: "file:src/a.ts" },
  ],
  activeTabId: "review",
  review: { scroll: { top: 0 }, mode: "unstaged" },
}

function renderWorkspace(props: Partial<Parameters<typeof ReviewWorkspace>[0]> = {}) {
  return render(() => <ReviewWorkspace sessionId="ses_test" directory="/repo/main" mode="uncommitted" {...props} />)
}

function tabButton(container: HTMLElement, tabId: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-slot="workspace-tab"][data-workspace-tab-id="${CSS.escape(tabId)}"] > button`,
  )
  expect(button, `tab button for ${tabId}`).toBeTruthy()
  return button!
}

// A click's handler writes stage until the microtask checkpoint that follows
// the event task, so the DOM the user sees after a click is the flushed one.
function clickTab(container: HTMLElement, tabId: string) {
  tabButton(container, tabId).click()
  flush()
}

function activeTabId(container: HTMLElement) {
  return container
    .querySelector('[data-slot="workspace-tab"][data-selected="true"]')
    ?.getAttribute("data-workspace-tab-id")
}

describe("last-interaction-wins activation", () => {
  test("a direct Review click is not overwritten by a pending deferred file activation", () => {
    // Opening a file link defers its activation by one frame so the tab's
    // content lays out before it becomes active.
    const { container } = renderWorkspace({
      focusPath: "src/new.ts",
      focusVersion: 1,
      focusFileIntent: "tab",
    })
    expect(activeTabId(container)).toBe("review")

    // The user clicks back onto Review inside that frame.
    clickTab(container, "review")
    expect(activeTabId(container)).toBe("review")

    // The superseded deferred activation must never fire: last click wins.
    flushFrames()
    expect(activeTabId(container)).toBe("review")
    // The never-activated pending mount was released with it.
    expect(container.querySelectorAll("[data-testid='mock-tab-file']")).toHaveLength(0)
  })

  test("an undisturbed deferred activation still commits on its frame", () => {
    const { container } = renderWorkspace({
      focusPath: "src/new.ts",
      focusVersion: 1,
      focusFileIntent: "tab",
    })
    flushFrames()
    expect(activeTabId(container)).toBe("file:src/new.ts")
  })
})

describe("review surface retention across tab deactivation", () => {
  test("deactivating Review keeps its viewport and binding alive, and marks the surface inert", () => {
    const { container } = renderWorkspace({ initialWorkingSet: workingSetWithFileTab })

    const firstViewport = mounts()[0]!.viewport!
    const firstObserver = FakeResizeObserver.instances[0]!
    expect(firstObserver.observed).toContain(firstViewport)
    expect(firstObserver.disconnected).toBe(false)
    expect(Object.getOwnPropertyDescriptor(firstViewport, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)).toBeTruthy()

    // Deactivate Review. The surface is retained — reconstructing it is the
    // whole cost of a Files -> Review click — so its DOM, its viewport binding
    // and its observer all stay, and it is marked inert instead.
    clickTab(container, "file:src/a.ts")
    const body = container.querySelector<HTMLElement>("[data-testid='workspace-review-body']")!
    expect(container.querySelector("[data-testid='mock-review-viewport']")).toBe(firstViewport)
    expect(body.dataset.reviewBodyInert).toBe("true")
    expect(body.getAttribute("aria-hidden")).toBe("true")
    expect(firstObserver.disconnected).toBe(false)
    expect(Object.getOwnPropertyDescriptor(firstViewport, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)).toBeTruthy()

    // Returning to Review reveals the same surface: no second mount, no second
    // observer, nothing rebuilt.
    clickTab(container, "review")
    expect(mounts()).toHaveLength(1)
    expect(mounts()[0]!.viewport).toBe(firstViewport)
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(body.dataset.reviewBodyInert).toBeUndefined()
    expect(body.getAttribute("aria-hidden")).toBeNull()
  })

  test("the viewport binding still dies with the surface's DOM", () => {
    renderWorkspace({ initialWorkingSet: workingSetWithFileTab })
    const observer = FakeResizeObserver.instances[0]!
    expect(observer.disconnected).toBe(false)

    // Closing the panel disposes the whole workspace — the one disposal the
    // zero-DOM contract is about — and the binding must go with it.
    cleanup()
    expect(observer.disconnected).toBe(true)
  })
})

describe("the retained surface keeps publishing its latest state", () => {
  test("Review → file tab → Review shows the live surface, and the boundary holds what it published", () => {
    const published: ReviewWorkspaceWorkingSetSnapshot[] = []
    const { container } = renderWorkspace({
      initialWorkingSet: workingSetWithFileTab,
      onWorkingSetChange: (snapshot) => published.push(snapshot),
    })

    expect(mounts()).toHaveLength(1)
    expect(mounts()[0]!.retained).toMatchObject({ mode: "unstaged" })

    // The user changes the surface while Review is open…
    mounts()[0]!.publishSurface({ mode: "staged", openDiffs: ["src/x.ts"], diffStyle: "split" })

    // …parks it behind a file tab, then comes back. The same surface is still
    // there, so what the user returns to is what they left — and the working
    // set the panel would restore a REAL remount from carries it too.
    clickTab(container, "file:src/a.ts")
    clickTab(container, "review")

    expect(mounts()).toHaveLength(1)
    expect(published.at(-1)?.review).toMatchObject({
      mode: "staged",
      openDiffs: ["src/x.ts"],
      diffStyle: "split",
    })
  })
})
