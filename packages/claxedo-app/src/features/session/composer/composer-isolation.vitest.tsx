import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { PromptInput } from "./composer"

const frameSnapshots = vi.hoisted(() => [] as Array<{
  newSession: boolean
  sessionLocked: boolean
  harnessSessionId?: string
  harnessDirectory?: string
  draftId?: string
  surfaceId?: string
}>)
const dialogShow = vi.hoisted(() => vi.fn())
const openSettingsProviders = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/solid-query", () => ({
  useQuery: (() => {
    let count = 0
    return () => {
      count += 1
      return count % 2 === 1 ? { data: { session: [] } } : { data: [] }
    }
  })(),
}))

vi.mock("@/features/session/composer/ui/frame", () => ({
  PromptInputFrame: (props: {
    rootRef: (el: HTMLDivElement) => void
    editorRef: (el: HTMLDivElement) => void
    scrollRef: (el: HTMLDivElement) => void
    fileInputRef: (el: HTMLInputElement) => void
    newSession: () => boolean
    sessionLocked: () => boolean
    harnessSessionId: () => string | undefined
    harnessDirectory: () => string | undefined
    draftId: () => string | undefined
    surfaceId: () => string | undefined
  }) => {
    const snapshot = {
      newSession: props.newSession(),
      sessionLocked: props.sessionLocked(),
      harnessSessionId: props.harnessSessionId(),
      harnessDirectory: props.harnessDirectory(),
      draftId: props.draftId(),
      surfaceId: props.surfaceId(),
    }
    frameSnapshots.push(snapshot)
    return (
      <dl
        data-testid="prompt-input-frame-probe"
        ref={(el) => {
          props.rootRef(el)
          props.scrollRef(el)
        }}
      >
        <input type="file" ref={(el) => props.fileInputRef(el)} />
        <div contentEditable ref={(el) => props.editorRef(el)} />
        <dt>new session</dt>
        <dd data-testid="new-session">{String(snapshot.newSession)}</dd>
        <dt>session locked</dt>
        <dd data-testid="session-locked">{String(snapshot.sessionLocked)}</dd>
        <dt>harness session id</dt>
        <dd data-testid="harness-session-id">{snapshot.harnessSessionId ?? ""}</dd>
        <dt>harness directory</dt>
        <dd data-testid="harness-directory">{snapshot.harnessDirectory ?? ""}</dd>
        <dt>draft id</dt>
        <dd data-testid="draft-id">{snapshot.draftId ?? ""}</dd>
        <dt>surface id</dt>
        <dd data-testid="surface-id">{snapshot.surfaceId ?? ""}</dd>
      </dl>
    )
  },
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
    view: () => undefined,
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
  openSettingsProviders,
}))

vi.mock("@/features/session/providers/session-selection", () => ({
  useLocal: () => ({
    agent: {
      list: () => [{ name: "build" }],
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
    current: () => [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: () => 0,
    dirty: () => false,
    set: vi.fn(),
    reset: vi.fn(),
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
  useComments: () => ({
    active: () => undefined,
    remove: vi.fn(),
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    active: undefined,
    show: dialogShow,
  }),
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
    directory: () => "/repo",
    surfaceId: () => "surface_1",
    active: () => true,
  }),
}))

afterEach(() => {
  frameSnapshots.length = 0
  dialogShow.mockClear()
  openSettingsProviders.mockClear()
  cleanup()
})

describe("composer component mode isolation", () => {
  test("mounts PromptInput in existing-session mode without app-shell providers", () => {
    const view = render(() => (
      <PromptInput
        mode={{
          kind: "session",
          ref: {
            sessionId: "ses_existing",
            host: "local",
          },
        }}
      />
    ))

    expect(view.getByTestId("new-session").textContent).toBe("false")
    expect(view.getByTestId("session-locked").textContent).toBe("true")
    expect(frameSnapshots).toHaveLength(1)
    expect(frameSnapshots[0]).toMatchObject({
      newSession: false,
      sessionLocked: true,
      harnessSessionId: "ses_existing",
      harnessDirectory: "/repo",
    })
  })

  test("mounts PromptInput in draft mode without inheriting session identity", () => {
    const view = render(() => (
      <PromptInput
        mode={{
          kind: "draft",
          draftId: "draft_surface",
          target: {
            worktree: "feature",
            workspaceKind: "cloud",
            workspaceId: "ws_cloud",
            signedControlPlane: true,
            harness: { id: "codex-acp" },
          },
        }}
        sessionDirectory="/workspace"
      />
    ))

    expect(view.getByTestId("new-session").textContent).toBe("true")
    expect(view.getByTestId("session-locked").textContent).toBe("false")
    expect(frameSnapshots).toHaveLength(1)
    expect(frameSnapshots[0]).toMatchObject({
      newSession: true,
      sessionLocked: false,
      harnessSessionId: "new",
      harnessDirectory: "/repo",
      draftId: "draft_surface",
      surfaceId: "surface_1",
    })
  })
})
