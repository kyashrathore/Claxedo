import { createSignal } from "solid-js"
/**
 * ReviewWorkspace inner-tab lifecycle, at the real component boundary.
 *
 * Three contracts under test, all against the actual ReviewWorkspace with only
 * its heavy leaves mocked:
 *
 *  - Activation is last-interaction-wins: a tab insertion defers its
 *    activation by one frame, and a direct tab click landing inside that frame
 *    must not be overwritten when the frame fires.
 *  - Only the active workspace tab owns a surface: leaving Review disposes its
 *    DOM, viewport binding, observer, shortcuts and effects.
 *  - Returning to Review remounts it from the state retained by the working-set
 *    boundary.
 */
import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"

import { ReviewWorkspace } from "./review-workspace"
import { REVIEW_SCROLL_DIAGNOSTIC_PROPERTY } from "./review-scroll-restoration"
import type { ReviewWorkspaceWorkingSetSnapshot } from "./review-workspace-working-set"

type ReviewTabMount = {
  focusedDiffPath: () => string | undefined
  focusedDiffMode: () => string | undefined
  retained: Record<string, unknown> | undefined
  viewport: HTMLDivElement | undefined
  publishSurface: (surface: Record<string, unknown>) => void
}

const reviewTabMounts = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock("@/features/review/ui/review-tab", () => ({
  ReviewTab: (props: {
    focusedDiffPath?: string
    focusedDiffMode?: string
    retained?: Record<string, unknown>
    onRetainedChange?: (surface: Record<string, unknown>) => void
    scrollRef?: (element: HTMLDivElement) => void
  }) => {
    const mount: ReviewTabMount = {
      focusedDiffPath: () => props.focusedDiffPath,
      focusedDiffMode: () => props.focusedDiffMode,
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
  useWorkspaceProcessPane: () => ({ configs: () => [] }),
}))

// The workspace watches the panel slice for the session a runtime deleted; the
// test drives it with a real signal so the effect tracks it as production does.
const deletedSession = vi.hoisted(() => ({ read: (() => undefined) as () => string | undefined }))

vi.mock("@/app/workbench/state", () => ({
  useClaxedoState: () => ({
    layout: { openPage: vi.fn() },
    workspacePanel: { close: vi.fn(), deletedSession: () => deletedSession.read() },
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

vi.mock("@/features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { sessionId?: () => string | undefined; children: JSX.Element }) => (
    <div data-testid="mock-session-pane-scope" data-session-id={props.sessionId?.()}>{props.children}</div>
  ),
}))

vi.mock("@/features/session/ui/session-screen", () => ({
  default: (props: { presentation: () => string; readOnly?: () => boolean }) => (
    <div
      data-testid="mock-session-screen"
      data-presentation={props.presentation()}
      data-read-only={props.readOnly?.() ? "true" : "false"}
    />
  ),
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
  const DropdownMenu = Object.assign(
    (props: { children: JSX.Element }) => <div>{props.children}</div>,
    {
      Trigger: (props: { children: JSX.Element }) => <button type="button">{props.children}</button>,
      Portal: (props: { children: JSX.Element }) => <>{props.children}</>,
      Content: (props: { children: JSX.Element }) => <div>{props.children}</div>,
      Item: (props: { children: JSX.Element }) => <div>{props.children}</div>,
    },
  )
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
}

beforeEach(() => {
  deletedSession.read = () => undefined
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
  return render(() => (
    <ReviewWorkspace
      sessionId="ses_test"
      directory="/repo/main"
      mode="uncommitted"
      {...props}
    />
  ))
}

function tabButton(container: HTMLElement, tabId: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-slot="workspace-tab"][data-workspace-tab-id="${CSS.escape(tabId)}"] > button`,
  )
  expect(button, `tab button for ${tabId}`).toBeTruthy()
  return button!
}

function activeTabId(container: HTMLElement) {
  return container
    .querySelector('[data-slot="workspace-tab"][data-selected="true"]')
    ?.getAttribute("data-workspace-tab-id")
}

describe("last-interaction-wins activation", () => {
  test("a top-level Workspace open reactivates Review without discarding warm tabs", () => {
    const { container } = renderWorkspace({
      initialWorkingSet: { ...workingSetWithFileTab, activeTabId: "file:src/a.ts" },
      focusReviewVersion: 1,
    })

    expect(activeTabId(container)).toBe("review")
    expect(container.querySelector('[data-workspace-tab-id="file:src/a.ts"]')).toBeTruthy()
  })

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
    tabButton(container, "review").click()
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

describe("review surface ownership across tab deactivation", () => {
  test("deactivating Review disposes its viewport and remounts it from retained state", () => {
    const { container } = renderWorkspace({ initialWorkingSet: workingSetWithFileTab })

    const firstViewport = mounts()[0].viewport!
    const firstObserver = FakeResizeObserver.instances[0]
    expect(firstObserver.observed).toContain(firstViewport)
    expect(firstObserver.disconnected).toBe(false)
    expect(Object.getOwnPropertyDescriptor(firstViewport, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)).toBeTruthy()

    tabButton(container, "file:src/a.ts").click()
    expect(container.querySelector("[data-testid='workspace-review-body']")).toBeNull()
    expect(container.querySelector("[data-testid='mock-review-viewport']")).toBeNull()
    expect(firstObserver.disconnected).toBe(true)
    expect(Object.getOwnPropertyDescriptor(firstViewport, REVIEW_SCROLL_DIAGNOSTIC_PROPERTY)).toBeUndefined()

    tabButton(container, "review").click()
    expect(mounts()).toHaveLength(2)
    expect(mounts()[1].viewport).not.toBe(firstViewport)
    expect(FakeResizeObserver.instances).toHaveLength(2)
  })

  test("the viewport binding still dies with the surface's DOM", () => {
    renderWorkspace({ initialWorkingSet: workingSetWithFileTab })
    const observer = FakeResizeObserver.instances[0]
    expect(observer.disconnected).toBe(false)

    // Closing the panel disposes the whole workspace — the one disposal the
    // zero-DOM contract is about — and the binding must go with it.
    cleanup()
    expect(observer.disconnected).toBe(true)
  })
})

describe("the working-set boundary retains the latest Review state", () => {
  test("Review → file tab → Review remounts from what the prior surface published", () => {
    const published: ReviewWorkspaceWorkingSetSnapshot[] = []
    const { container } = renderWorkspace({
      initialWorkingSet: workingSetWithFileTab,
      onWorkingSetChange: (snapshot) => published.push(snapshot),
    })

    expect(mounts()).toHaveLength(1)
    expect(mounts()[0].retained).toMatchObject({ mode: "unstaged" })

    // The user changes the surface while Review is open…
    mounts()[0].publishSurface({ mode: "staged", openDiffs: ["src/x.ts"], diffStyle: "split" })

    // …leaves it for a file tab, then comes back. The surface remounts while
    // the boundary supplies the same canonical state.
    tabButton(container, "file:src/a.ts").click()
    tabButton(container, "review").click()

    expect(mounts()).toHaveLength(2)
    expect(mounts()[1].retained).toMatchObject({
      mode: "staged",
      openDiffs: ["src/x.ts"],
      diffStyle: "split",
    })
    expect(published.at(-1)?.review).toMatchObject({
      mode: "staged",
      openDiffs: ["src/x.ts"],
      diffStyle: "split",
    })
  })
})

describe("review-intent focus", () => {
  test("activates Review even though consuming the request clears the intent synchronously", () => {
    const [intent, setIntent] = createSignal<"tab" | "review" | undefined>("review")
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_test"
        directory="/repo/main"
        mode="uncommitted"
        focusPath="src/new.ts"
        focusVersion={1}
        focusFileIntent={intent()}
        onFocusConsumed={() => setIntent(undefined)}
      />
    ))
    flushFrames()
    expect(activeTabId(container)).toBe("review")
    expect(container.querySelector('[data-workspace-tab-id="file:src/new.ts"]')).toBeNull()
    const tab = mounts().at(-1)
    expect(tab?.focusedDiffPath()).toBe("src/new.ts")
  })

  test("hands the file and its review mode to the Review tab after the request was consumed", () => {
    const [focus, setFocus] = createSignal<{ path?: string; mode?: "staged" | "unstaged"; intent?: "review" }>({
      path: "src/new.ts",
      mode: "staged",
      intent: "review",
    })
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_test"
        directory="/repo/main"
        mode="uncommitted"
        focusPath={focus().path}
        focusVersion={1}
        focusFileIntent={focus().intent}
        focusReviewMode={focus().mode}
        onFocusConsumed={() => setFocus({})}
      />
    ))
    flushFrames()
    expect(activeTabId(container)).toBe("review")
    const tab = mounts().at(-1)
    expect(tab?.focusedDiffPath()).toBe("src/new.ts")
    expect(tab?.focusedDiffMode()).toBe("staged")
  })
})

describe("subagent focus", () => {
  test("opens the child's transcript as its own tab, named by the agent that ran", async () => {
    // The panel clears its focus the moment the request is consumed, so the
    // label has to have been read before that.
    const [focus, setFocus] = createSignal<{ sessionId?: string; label?: string }>({
      sessionId: "ses_child",
      label: "code-reviewer",
    })
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId={focus().sessionId}
        focusSubagentLabel={focus().label}
        focusSubagentVersion={1}
        onFocusConsumed={() => setFocus({})}
      />
    ))
    flushFrames()

    expect(activeTabId(container)).toBe("subagent:ses_child")
    expect(tabButton(container, "subagent:ses_child").textContent).toContain("code-reviewer")
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="mock-session-pane-scope"]')?.getAttribute("data-session-id"))
        .toBe("ses_child"),
    )
  })

  test("a second subagent opens beside the first instead of replacing it", () => {
    const [focus, setFocus] = createSignal({ sessionId: "ses_a", label: "explorer", version: 1 })
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId={focus().sessionId}
        focusSubagentLabel={focus().label}
        focusSubagentVersion={focus().version}
      />
    ))
    flushFrames()
    setFocus({ sessionId: "ses_b", label: "code-reviewer", version: 2 })
    flushFrames()

    expect(container.querySelectorAll('[data-workspace-tab-kind="subagent"]').length).toBe(2)
    expect(activeTabId(container)).toBe("subagent:ses_b")
  })

  test("reopening a subagent already on screen selects its tab", () => {
    const [version, setVersion] = createSignal(1)
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentVersion={version()}
      />
    ))
    flushFrames()
    tabButton(container, "review").click()
    expect(activeTabId(container)).toBe("review")

    setVersion(2)
    flushFrames()

    expect(container.querySelectorAll('[data-workspace-tab-kind="subagent"]').length).toBe(1)
    expect(activeTabId(container)).toBe("subagent:ses_child")
  })
})

describe("a subagent tab belongs to its parent session", () => {
  test("the pane switching session hides the transcript, and switching back shows it", () => {
    const [sessionId, setSessionId] = createSignal("ses_parent")
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId={sessionId()}
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentLabel="explorer"
        focusSubagentVersion={1}
      />
    ))
    flushFrames()
    expect(activeTabId(container)).toBe("subagent:ses_child")

    setSessionId("ses_sibling")
    flushFrames()
    expect(container.querySelector('[data-workspace-tab-id="subagent:ses_child"]')).toBeNull()
    expect(activeTabId(container)).toBe("review")
    expect(container.querySelector('[data-testid="mock-session-pane-scope"]')).toBeNull()

    setSessionId("ses_parent")
    flushFrames()
    expect(container.querySelector('[data-workspace-tab-id="subagent:ses_child"]')).toBeTruthy()
  })

  test("deleting the parent closes the transcripts it opened", () => {
    const [deleted, setDeleted] = createSignal<string>()
    deletedSession.read = deleted
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentLabel="explorer"
        focusSubagentVersion={1}
      />
    ))
    flushFrames()
    expect(activeTabId(container)).toBe("subagent:ses_child")

    setDeleted("ses_parent")
    flushFrames()

    expect(container.querySelector('[data-workspace-tab-id="subagent:ses_child"]')).toBeNull()
    expect(activeTabId(container)).toBe("review")
  })

  test("deleting the child closes its own transcript", () => {
    const [deleted, setDeleted] = createSignal<string>()
    deletedSession.read = deleted
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentVersion={1}
      />
    ))
    flushFrames()

    setDeleted("ses_child")
    flushFrames()

    expect(container.querySelector('[data-workspace-tab-id="subagent:ses_child"]')).toBeNull()
  })

  test("reopening a transcript retitles its tab from the row that was clicked", () => {
    const [focus, setFocus] = createSignal({ label: "explorer", version: 1 })
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentLabel={focus().label}
        focusSubagentVersion={focus().version}
      />
    ))
    flushFrames()
    expect(tabButton(container, "subagent:ses_child").textContent).toContain("explorer")

    setFocus({ label: "code-reviewer", version: 2 })
    flushFrames()

    expect(container.querySelectorAll('[data-workspace-tab-kind="subagent"]').length).toBe(1)
    expect(tabButton(container, "subagent:ses_child").textContent).toContain("code-reviewer")
  })
})

describe("the docked child transcript", () => {
  test("renders docked and read-only, which is what leaves it its own task heading", async () => {
    const { container } = render(() => (
      <ReviewWorkspace
        sessionId="ses_parent"
        directory="/repo/main"
        mode="uncommitted"
        focusSubagentSessionId="ses_child"
        focusSubagentVersion={1}
      />
    ))
    flushFrames()

    const screen = await vi.waitFor(() => {
      const element = container.querySelector('[data-testid="mock-session-screen"]')
      expect(element).toBeTruthy()
      return element!
    })
    expect(screen.getAttribute("data-presentation")).toBe("docked")
    expect(screen.getAttribute("data-read-only")).toBe("true")
  })
})
