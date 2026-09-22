// A subagent transcript docked in the workspace panel is read-only: the reader
// cannot prompt it, and must not be able to route the pane to the parent. It
// still has to answer the permission and question requests that block the
// child, because this dock is the only surface that shows them.
//
// The provider stack mirrors session-presentation.vitest.tsx, including the
// frame stub that carries the editor's real `data-component`/`role`, so an
// assertion that no prompt exists is an assertion about the region's branch
// rather than about a missing mock.
import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AgentPermission, AgentQuestion, AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { SessionComposerRegion } from "./session-composer-region"
import type { SessionComposerState } from "./session-composer-state"

vi.mock("@tanstack/solid-query", () => ({
  queryOptions: <T,>(options: T) => options,
  skipToken: Symbol.for("skipToken"),
  useQuery: (options: () => { queryKey: readonly unknown[] }) => {
    const key = options().queryKey
    if (key[0] === "directory" && key[2] === "sessionCache") return { data: { session: [] } }
    if (key[0] === "projects") return { data: [] }
    return { data: undefined }
  },
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock("@/features/session/composer/ui/frame", () => ({
  PromptInputFrame: (props: {
    rootRef: (el: HTMLDivElement) => void
    editorRef: (el: HTMLDivElement) => void
    scrollRef: (el: HTMLDivElement) => void
    fileInputRef: (el: HTMLInputElement) => void
  }) => (
    <div
      ref={(el) => {
        props.rootRef(el)
        props.scrollRef(el)
      }}
    >
      <input type="file" ref={(el) => props.fileInputRef(el)} />
      <div data-component="prompt-input" role="textbox" aria-multiline="true" contenteditable="true" ref={(el) => props.editorRef(el)} />
    </div>
  ),
}))

vi.mock("@/features/session/composer/ui/submit", () => ({
  createPromptSubmit: () => ({
    abort: vi.fn(),
    handleSubmit: (event: Event) => event.preventDefault(),
  }),
}))

vi.mock("@/platform/query/query-client", () => ({
  queryClient: {
    fetchQuery: vi.fn(async () => []),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    removeQueries: vi.fn(),
    getQueryCache: () => ({ subscribe: () => () => {} }),
  },
}))

vi.mock("@/features/session/app-ports", async () => ({
  ...(await import("@/app/workbench/context/pane-ctx")),
  useCommand: () => ({
    options: [],
    slashOptions: [],
    register: vi.fn(),
    trigger: vi.fn(),
    keybind: () => undefined,
  }),
  useFile: () => ({
    pathFromTab: () => undefined,
    searchFilesAndDirectories: async () => [],
  }),
  useLayout: () => ({
    tabs: () => ({ all: () => [], active: () => undefined }),
    view: () => ({ todoCollapsed: { get: () => false, set: vi.fn() } }),
  }),
  useProviders: () => ({
    connected: () => [],
    default: () => ({}),
    loading: () => false,
  }),
  useSDK: () => ({
    directory: "/repo",
    url: "http://127.0.0.1:3001",
    workspace: () => undefined,
    client: {},
    createClient: () => ({}),
  }),
  useShellQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
    providers: () => ({ queryKey: ["providers"], queryFn: async () => [] }),
  }),
  useWorkspaceQuery: () => ({ data: [] }),
  workspacePlacement: () => undefined,
  listDocumentMentions: vi.fn(async () => []),
  documentMentionText: vi.fn(),
  openSettingsModels: vi.fn(),
}))

vi.mock("@/features/session/providers/session-selection", () => ({
  useLocal: () => ({
    agent: {
      list: () => [{ name: "build" }],
      catalog: () => [{ name: "build" }],
      current: () => ({ name: "build" }),
      set: vi.fn(),
    },
    model: {
      current: () => ({ id: "big-pickle", name: "Big Pickle", provider: { id: "opencode" } }),
      currentSource: () => "selected",
      list: () => [{ id: "big-pickle", name: "Big Pickle", provider: { id: "opencode" } }],
      selected: () => ({ id: "big-pickle", name: "Big Pickle", provider: { id: "opencode" } }),
      ready: () => true,
      visible: () => true,
      set: vi.fn(),
      restorePending: () => false,
      selectionCatalogPending: () => false,
      variant: {
        current: () => undefined,
        selected: () => undefined,
        configured: () => undefined,
        list: () => [],
        set: vi.fn(),
      },
    },
  }),
}))

vi.mock("@/features/session/providers/prompt", () => ({
  DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
  isPromptEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  usePrompt: () => ({
    ready: () => true,
    current: () => [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: () => 0,
    dirty: () => false,
    set: vi.fn(),
    reset: vi.fn(),
    goal: { armed: () => false, setArmed: vi.fn() },
    context: {
      items: () => [],
      add: vi.fn(),
      remove: vi.fn(),
      removeComment: vi.fn(),
      updateComment: vi.fn(),
      replaceComments: vi.fn(),
    },
  }),
}))

vi.mock("@/platform/comments/provider", () => ({
  useComments: () => ({ active: () => undefined, remove: vi.fn() }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ active: undefined, show: vi.fn() }),
}))

vi.mock("@/features/session/providers/permission", () => ({
  usePermission: () => ({
    isAutoAccepting: () => false,
    isAutoAcceptingDirectory: () => false,
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, params?: { fallback?: string }) => params?.fallback ?? key,
  }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({
    platform: "web",
    fetch: vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    openLink: vi.fn(),
    restart: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    notify: vi.fn(),
  }),
}))

vi.mock("@/features/session/providers/session-params", () => ({
  useSessionParams: () => ({
    sessionId: () => "ses_child",
    directory: () => "/repo",
    surfaceId: () => "surface_1",
    active: () => true,
  }),
}))

// jsdom ships no ResizeObserver; the question dock measures its options list
// through @solid-primitives/resize-observer on mount.
class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub

afterEach(cleanup)

const idleState: SessionComposerState = {
  blocked: () => false,
  dock: () => false,
  closing: () => false,
  opening: () => false,
  questionRequest: () => undefined,
  permissionRequest: () => undefined,
  permissionResponding: () => false,
  requestReadError: () => undefined,
  decide: vi.fn(),
  todos: () => [],
}

const permissionRequest: AgentPermission = {
  id: "permission-1",
  sessionID: "ses_child",
  permission: "bash",
  patterns: [],
  always: [],
  metadata: { command: "rm -rf build" },
}

const questionRequest: AgentQuestion = {
  id: "question-1",
  sessionID: "ses_child",
  questions: [
    {
      question: "Which branch should the fix land on?",
      header: "Branch",
      options: [
        { label: "dev", description: "the shared branch" },
        { label: "feature", description: "a new branch" },
      ],
    },
  ],
}

function mountRegion(input: {
  state?: Partial<SessionComposerState>
  parentID?: string
  readOnly?: boolean
  onNavigateParent?: () => void
  onRetryRequests?: () => Promise<unknown>
  sessionID?: string
  status?: () => AgentRuntimeStatus
}) {
  return render(() => (
    <SessionComposerRegion
      sessionID={input.sessionID}
      status={input.status}
      state={{ ...idleState, ...input.state }}
      ready
      centered
      presentation="docked"
      parentID={input.parentID}
      readOnly={() => input.readOnly === true}
      mode={{ kind: "session", ref: { sessionId: "ses_child", host: "local" } }}
      inputRef={() => {}}
      newSessionWorktree="main"
      onNewSessionWorktreeReset={() => {}}
      onSubmit={() => {}}
      onResponseSubmit={() => {}}
      onRetryRequests={input.onRetryRequests}
      beforeInput={<span>Normal running status</span>}
      onNavigateParent={input.onNavigateParent ?? (() => {})}
      setPromptDockRef={() => {}}
    />
  ))
}

const editor = () => document.querySelector<HTMLElement>('[data-component="prompt-input"]')
const permissionDock = () => document.querySelector<HTMLElement>('[data-slot="permission-header-title"]')
const questionDock = () => document.querySelector<HTMLElement>('[data-slot="question-header-title"]')

describe("the composer region for a read-only docked subagent", () => {
  test("a blocking permission is answerable and no prompt replaces it", () => {
    mountRegion({
      parentID: "ses_parent",
      readOnly: true,
      state: { blocked: () => true, permissionRequest: () => permissionRequest },
    })

    expect(permissionDock()).toBeTruthy()
    expect(document.querySelector('[data-slot="permission-command"]')?.textContent).toBe("rm -rf build")
    expect(editor()).toBeNull()
    expect(document.body.textContent).toContain("session.child.promptDisabled")
  })

  test("a blocking question is answerable and no prompt replaces it", () => {
    mountRegion({
      parentID: "ses_parent",
      readOnly: true,
      state: { blocked: () => true, questionRequest: () => questionRequest },
    })

    expect(questionDock()).toBeTruthy()
    expect(document.body.textContent).toContain("Which branch should the fix land on?")
    expect(editor()).toBeNull()
  })

  test("a read-only surface offers no route out of the pane the reader opened", () => {
    const view = mountRegion({
      parentID: "ses_parent",
      readOnly: true,
      state: { blocked: () => true, permissionRequest: () => permissionRequest },
    })

    expect(document.body.textContent).toContain("session.child.promptDisabled")
    expect(view.queryByRole("button", { name: "session.child.backToParent" })).toBeNull()
  })

  test("a child in its own pane keeps the route back to its parent", () => {
    const onNavigateParent = vi.fn()
    const view = mountRegion({ parentID: "ses_parent", onNavigateParent })

    fireEvent.click(view.getByRole("button", { name: "session.child.backToParent" }))
    expect(onNavigateParent).toHaveBeenCalledTimes(1)
  })

  // A read-only session with no parent has no live caller yet, and no
  // dictionary line of its own: the prompt's place stays empty rather than
  // borrowing the child notice, which would name a parent that does not exist.
  test("a read-only session with no parent answers its permission and shows neither prompt nor notice", () => {
    mountRegion({ readOnly: true, state: { blocked: () => true, permissionRequest: () => permissionRequest } })

    expect(permissionDock()).toBeTruthy()
    expect(editor()).toBeNull()
    expect(document.body.textContent).not.toContain("session.child.promptDisabled")
  })

  test("read-only suppresses the prompt with nothing blocking and no parent to make it a child", () => {
    mountRegion({ readOnly: true })

    expect(editor()).toBeNull()
  })

  test("a session the reader owns still renders the prompt this harness would show", () => {
    mountRegion({})

    expect(editor()).toBeTruthy()
  })
})


test("request loading failures replace progress with a retryable alert and recover", async () => {
  const [error, setError] = createSignal<string | undefined>("Permission storage unavailable")
  let complete!: () => void
  const retry = vi.fn(() => new Promise<void>((resolve) => { complete = () => { setError(undefined); resolve() } }))
  const view = mountRegion({ state: { requestReadError: error }, onRetryRequests: retry })
  expect(view.getByRole("alert").textContent).toContain("Permission storage unavailable")
  expect(view.queryByText("Normal running status")).toBeNull()
  const button = view.getByRole<HTMLButtonElement>("button", { name: "ui.message.queued.retry" })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  complete()
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull())
  expect(view.getByText("Normal running status")).toBeTruthy()
})

test("a failed request retry keeps the blocker visible and permits another retry", async () => {
  const retry = vi.fn().mockRejectedValue(new Error("Permission service still unavailable"))
  const view = mountRegion({ state: { requestReadError: () => "Permission storage unavailable" }, onRetryRequests: retry })
  const button = view.getByRole<HTMLButtonElement>("button", { name: "ui.message.queued.retry" })
  fireEvent.click(button)
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Permission service still unavailable"))
  expect(button.disabled).toBe(false)
  expect(view.queryByText("Normal running status")).toBeNull()
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(2)
})

test("native startup questions retain the same canonical composer dock", () => {
  mountRegion({ state: { blocked: () => true, questionRequest: () => questionRequest } })
  expect(questionDock()?.closest('[data-component="session-prompt-dock"]')).not.toBeNull()
  expect(editor()).toBeNull()
  expect(document.querySelector('[data-component="session-new-design"]')).toBeNull()
})
