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
  modelHarnessMode: boolean
}>)

vi.mock("@opencode-ai/ui/motion-spring", () => ({
  useSpring: (value: () => number) => value,
}))

vi.mock("@tanstack/solid-query", () => ({
  useQuery: (() => {
    let count = 0
    return () => {
      count += 1
      return count % 2 === 1 ? { data: { session: [] } } : { data: [] }
    }
  })(),
}))

vi.mock("@/components/prompt-input/frame", () => ({
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
    modelHarnessMode: () => boolean
  }) => {
    const snapshot = {
      newSession: props.newSession(),
      sessionLocked: props.sessionLocked(),
      harnessSessionId: props.harnessSessionId(),
      harnessDirectory: props.harnessDirectory(),
      draftId: props.draftId(),
      surfaceId: props.surfaceId(),
      modelHarnessMode: props.modelHarnessMode(),
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
        <dt>model harness mode</dt>
        <dd data-testid="model-harness-mode">{String(snapshot.modelHarnessMode)}</dd>
      </dl>
    )
  },
}))

vi.mock("@/components/prompt-input/submit", () => ({
  createPromptSubmit: () => ({
    abort: vi.fn(),
    handleSubmit: (event: Event) => event.preventDefault(),
  }),
}))

vi.mock("../../shared/query/query-client", () => ({
  queryClient: {
    fetchQuery: vi.fn(async () => []),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    removeQueries: vi.fn(),
  },
}))

vi.mock("@claxedo/shell/data/query-options", () => ({
  useShellQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
    providers: () => ({ queryKey: ["providers"], queryFn: async () => [] }),
  }),
}))

vi.mock("../../shell/workspace/use-workspace-query", () => ({
  useWorkspaceQuery: () => ({ data: [] }),
}))

vi.mock("../../shared/query/shell", () => ({
  commandListQuery: () => ({ queryKey: ["commands"], queryFn: async () => [] }),
}))

vi.mock("@claxedo/context/use-providers", () => ({
  useProviders: () => ({
    connected: () => [{ id: "opencode", models: [{ id: "big-pickle", name: "Big Pickle" }] }],
    default: () => ({ opencode: "big-pickle" }),
    loading: () => false,
    paid: () => [{ id: "opencode" }],
  }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    directory: "/repo",
    url: "http://127.0.0.1:3001",
    workspace: () => undefined,
    client: {},
    createClient: () => ({}),
  }),
}))

vi.mock("@/context/local", () => ({
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

vi.mock("@/context/prompt", () => ({
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

vi.mock("@/context/file", () => ({
  useFile: () => ({
    pathFromTab: () => undefined,
    searchFilesAndDirectories: async () => [],
  }),
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    tabs: () => ({
      all: () => [],
      active: () => undefined,
    }),
    view: () => undefined,
  }),
}))

vi.mock("@/context/comments", () => ({
  useComments: () => ({
    active: () => undefined,
    remove: vi.fn(),
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    active: undefined,
    show: vi.fn(),
  }),
}))

vi.mock("@claxedo/context/command", () => ({
  useCommand: () => ({
    options: [],
    register: vi.fn(),
    keybind: () => undefined,
  }),
}))

vi.mock("@/context/permission", () => ({
  usePermission: () => ({
    isAutoAccepting: () => false,
    isAutoAcceptingDirectory: () => false,
  }),
}))

vi.mock("@claxedo/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: { fallback?: string }) => params?.fallback ?? key,
  }),
}))

vi.mock("@claxedo/context/platform", () => ({
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

vi.mock("../../claxedo-ui/context/session-params", () => ({
  useSessionParams: () => ({
    directory: () => "/repo",
    surfaceId: () => "surface_1",
    active: () => true,
  }),
}))

vi.mock("../../shell/chat/conversation-registry", () => ({
  registeredConversationHasUserMessage: () => false,
}))

afterEach(() => {
  frameSnapshots.length = 0
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

  test("hides the legacy model selector when the harness selector is in harness mode", () => {
    const view = render(() => (
      <PromptInput
        mode={{
          kind: "draft",
          target: undefined,
          draftId: "draft_codex",
        }}
        harnessSelectionController={{
          read: () => ({
            harness: "codex-app-server",
            isHarnessMode: true,
            readiness: "ready",
            models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
            selectedModel: "gpt-5.5",
            optionsStale: false,
            optionsLoading: false,
            configError: undefined,
          }),
          hydrate: vi.fn(),
          setHarness: vi.fn(),
          setModel: vi.fn(),
        }}
      />
    ))

    expect(view.getByTestId("model-harness-mode").textContent).toBe("true")
    expect(frameSnapshots).toHaveLength(1)
    expect(frameSnapshots[0]).toMatchObject({
      newSession: true,
      modelHarnessMode: true,
    })
  })
})
