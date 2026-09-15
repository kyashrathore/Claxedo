// The floating presentation is a geometry change on the ONE composer the
// session owns. These tests drive the real SessionComposerRegion and the real
// PromptInput through docked → floating → docked and hold the editor node's
// identity across the flip, which is what keeps focus, draft text and docks
// alive while the workspace panel covers the pane.
//
// The provider stack mirrors composer-isolation.vitest.tsx; the frame is
// stubbed at the same seam, carrying the attributes the real editor renders
// (`data-component`, `role`, `contenteditable`) so `focusComposerSurface`
// resolves it the way it resolves the real one.
import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { focusComposerSurface } from "@/features/session/composer/ui/composer-focus"
import type { SessionComposerState } from "./composer/session-composer-state"
import { SessionComposerRegion } from "./composer/session-composer-region"
import type { PanePresentation } from "@/features/session/app-ports"

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
      data-testid="prompt-input-frame-probe"
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

vi.mock("@/features/session/app-ports", () => ({
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
  openSettingsProviders: vi.fn(),
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
      visible: () => true,
      ready: () => true,
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
    sessionId: () => "ses_existing",
    directory: () => "/repo",
    surfaceId: () => "surface_1",
    active: () => true,
  }),
}))

afterEach(cleanup)

const composerState: SessionComposerState = {
  blocked: () => false,
  dock: () => false,
  closing: () => false,
  opening: () => false,
  questionRequest: () => undefined,
  permissionRequest: () => undefined,
  permissionResponding: () => false,
  decide: vi.fn(),
  todos: () => [],
}

function mountRegion(presentation: () => PanePresentation, extra?: { revert?: { items: { id: string; text: string }[]; onRestore: (id: string) => void } }) {
  return render(() => (
    <SessionComposerRegion
      state={composerState}
      ready
      centered
      presentation={presentation()}
      revert={extra?.revert}
      mode={{ kind: "session", ref: { sessionId: "ses_existing", host: "local" } }}
      inputRef={() => {}}
      newSessionWorktree="main"
      onNewSessionWorktreeReset={() => {}}
      onSubmit={() => {}}
      onResponseSubmit={() => {}}
      onNavigateParent={() => {}}
      setPromptDockRef={() => {}}
    />
  ))
}

const editor = () => document.querySelector<HTMLElement>('[data-component="prompt-input"]')
const dock = () => document.querySelector<HTMLElement>('[data-component="session-prompt-dock"]')

describe("session presentation — the composer region", () => {
  test("keeps the same editor node across docked → floating → docked and only swaps the dock surface", () => {
    const [presentation, setPresentation] = createSignal<PanePresentation>("docked")
    mountRegion(presentation)

    const node = editor()
    expect(node).toBeTruthy()
    expect(dock()).toHaveClass("shrink-0", "pb-3", "bg-background-stronger")
    expect(dock()).not.toHaveClass("session-floating-dock")

    setPresentation("floating")
    expect(editor()).toBe(node)
    expect(dock()).toHaveClass("shrink-0", "session-floating-dock")
    expect(dock()).not.toHaveClass("pb-3")
    expect(dock()).not.toHaveClass("bg-background-stronger")

    setPresentation("docked")
    expect(editor()).toBe(node)
    expect(dock()).toHaveClass("shrink-0", "pb-3", "bg-background-stronger")
    expect(dock()).not.toHaveClass("session-floating-dock")
  })

  test("focusComposerSurface resolves the floating composer, and the same node once docked again", () => {
    const [presentation, setPresentation] = createSignal<PanePresentation>("floating")
    mountRegion(presentation)

    const node = editor()
    expect(focusComposerSurface(document)).toBe(true)
    expect(document.activeElement).toBe(node)

    setPresentation("docked")
    expect(document.activeElement).toBe(node)
    expect(focusComposerSurface(document)).toBe(true)
    expect(document.activeElement).toBe(node)
  })

  test("floating drops the lift docked mode uses to tuck the composer under the revert dock", () => {
    const [presentation, setPresentation] = createSignal<PanePresentation>("docked")
    mountRegion(presentation, { revert: { items: [{ id: "m-1", text: "undo me" }], onRestore: () => {} } })

    const lifted = editor()!.closest<HTMLElement>(".relative.z-10")!
    expect(lifted.style.marginTop).toBe("-18px")

    setPresentation("floating")
    expect(lifted.style.marginTop).toBe("0px")

    setPresentation("docked")
    expect(lifted.style.marginTop).toBe("-18px")
  })
})
