import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
const calls = { prompt: 0, async: 0, create: 0, transportAsync: 0 }
const boots: Array<{ runner: string; sessionID?: string } | undefined> = []
const apiCalls: Array<{ url: string; method?: string; body?: string | null }> = []
const navCalls: string[] = []
const handoffCalls: Array<{ dir: string; sessionID: string }> = []
const toasts: Array<{ title?: string; description?: string }> = []
const promptCalls = {
  reset: [] as Array<unknown>,
  set: [] as Array<{ prompt: Prompt; cursor?: number; scope?: unknown }>,
}
const optimisticAdds: Array<{ directory?: string; sessionID: string }> = []
let demoMode = true
let acpMode = false
let mockClaxedoState: any
let mockSessionParams:
  | {
      sessionId: () => string | undefined
      directory: () => string
      paneId: () => string | undefined
      surfaceId: () => string | undefined
      leafId: () => string | undefined
    }
  | undefined

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string) => {
      navCalls.push(path)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@opencode-ai/app-shared", () => ({
    getExtensions: () => ({
      server: {
        resolveSessionUrl: async (sessionID: string) => demoMode ? null : `http://runtime.example.com/${sessionID}`,
      },
    }),
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: () => ({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        prompt: async () => {
          calls.prompt += 1
          return { data: undefined }
        },
        promptAsync: async () => {
          calls.transportAsync += 1
          return { data: undefined }
        },
      },
    }),
  }))

  mock.module("@claxedo/utils/api", () => ({
    isDemoMode: () => demoMode,
    getClaxedoServerUrl: () => "http://localhost:3001",
    getDefaultBaseUrl: () => "http://localhost:3001",
    authFetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      apiCalls.push({
        url: request.url,
        method: request.method,
        body: init?.body ? String(init.body) : null,
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => undefined },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept: () => undefined,
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: (scope?: unknown) => {
        promptCalls.reset.push(scope)
      },
      set: (prompt: Prompt, cursor?: number, scope?: unknown) => {
        promptCalls.set.push({ prompt, cursor, scope })
      },
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: (dir: string, sessionID: string) => {
          handoffCalls.push({ dir, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      directory: "/repo/main",
      url: "http://localhost:4096",
      client: {
        worktree: {
          create: async () => ({ data: { directory: "/repo/main/new" } }),
        },
        session: {
          create: async () => {
            calls.create += 1
            return { data: { id: "session-1" } }
          },
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async () => {
            calls.async += 1
            return { data: undefined }
          },
          shell: async () => ({ data: undefined }),
          command: async () => ({ data: undefined }),
          abort: async () => ({ data: undefined }),
        },
      },
      createClient: () => ({
        session: {
          create: async () => {
            calls.create += 1
            return { data: { id: "session-1" } }
          },
          prompt: async () => {
            calls.prompt += 1
            return { data: undefined }
          },
          promptAsync: async () => {
            calls.async += 1
            return { data: undefined }
          },
        },
      }),
    }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (input: { directory?: string; sessionID: string }) => {
            optimisticAdds.push(input)
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      child: () => [{}, () => undefined],
      todo: {
        set: () => undefined,
      },
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: globalThis.fetch,
    }),
  }))

  mock.module("@/components/prompt-input/build-request-parts", () => ({
    buildRequestParts: () => ({
      requestParts: [],
      optimisticParts: [],
    }),
  }))

  mock.module("@/components/prompt-input/editor-dom", () => ({
    setCursorPosition: () => undefined,
  }))

  mock.module("../../../claxedo-ui/context/session-params", () => ({
    useSessionParams: () => {
      if (mockSessionParams) return mockSessionParams
      throw new Error("no session params")
    },
  }))

  mock.module("../../../claxedo-ui/state", () => ({
    sessionRoute: (dir: string, id?: string) => `/${dir}/session${id ? `/${id}` : ""}`,
    useClaxedoState: () => {
      if (mockClaxedoState) return mockClaxedoState
      throw new Error("no claxedo state")
    },
  }))

  mock.module("../../../claxedo-ui/context/acp-config", () => ({
    useAcpConfig: () => ({
      isAcpMode: () => acpMode,
      acpModelForSubmit: () => (acpMode ? { id: "opus", name: "Opus", provider: { id: "claude-acp" } } : undefined),
      claimSession: async () => (acpMode ? { id: "session-1" } : undefined),
      displayName: () => "Claude",
      runner: () => "claude-acp",
      selectedModel: () => "opus",
      readiness: () => "ready",
      promote: () => undefined,
    }),
  }))

  mock.module("../../../pane/store/pane-preferences", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  mock.module("@/pane/store/pane-preferences", () => ({
    panePreferenceScope: () => "scope",
    PANE_PREFERENCE_KEYS: [],
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  calls.prompt = 0
  calls.async = 0
  calls.create = 0
  calls.transportAsync = 0
  boots.length = 0
  navCalls.length = 0
  handoffCalls.length = 0
  toasts.length = 0
  promptCalls.reset = []
  promptCalls.set = []
  optimisticAdds.length = 0
  apiCalls.length = 0
  demoMode = true
  acpMode = false
  mockClaxedoState = undefined
  mockSessionParams = undefined
})

describe("prompt submit demo path", () => {
  test("uses the shared demo helper to send sync prompts", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.prompt).toBe(1)
    expect(calls.async).toBe(0)
  })

  test("ACP draft submit reuses the prewarmed session instead of creating one on send", async () => {
    demoMode = false
    acpMode = true

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(boots).toEqual([
      { runner: "Claude", sessionID: undefined },
      { runner: "Claude", sessionID: "session-1" },
    ])
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0]?.url).toBe("http://localhost:3001/session/session-1/config?directory=%2Frepo%2Fmain")
    expect(apiCalls[0]?.method).toBe("PATCH")
    expect(JSON.parse(apiCalls[0]?.body ?? "{}")).toEqual({
      runner: { type: "claude-acp" },
      agent: "agent",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
  })

  test("clears the original draft scope after creating a new session", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      draftId: () => "draft-1",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(promptCalls.reset).toEqual([
      { dir: "__draft__/draft-1", id: "new" },
      { dir: "/repo/main", id: "session-1" },
    ])
  })

  test("unattached drafts refuse to create a session from the sdk directory fallback", async () => {
    demoMode = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => undefined,
      draftId: () => "draft-unbound",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.prompt).toBe(0)
    expect(calls.async).toBe(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.sessionCreateFailed.title",
        description: "Attach a workspace before sending a prompt.",
      },
    ])
  })

  test("reuses the active new-session tab when the first prompt creates a real session", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []

    mockClaxedoState = {
      wb: {
        state: { panes: [] },
        selectors: {
          focusedContent: () => "tab-new",
        },
      },
      meta: {
        get: () => ({
          id: "tab-new",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
          content: { type: "session", directory: "/repo/main", sessionId: "new", title: "New Session" },
        }),
        patch: (id, patch) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: (directory, sessionID, title) => {
          openCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        showContent: (id) => {
          showCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([
      {
        id: "tab-new",
        patch: {
          sessionId: "session-1",
          content: { type: "session", directory: "/repo/main", sessionId: "session-1", title: "New Session" },
        },
      },
    ])
    expect(openCalls).toEqual([])
    expect(showCalls).toEqual(["tab-new"])
    expect(handoffCalls).toEqual([{ dir: "/repo/main", sessionID: "session-1" }])
    expect(navCalls).toEqual(["//repo/main/session/session-1"])
  })

  test("closes the active draft-session tab after handing off to a real session", async () => {
    demoMode = false

    const closeCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []
    const showCalls: string[] = []

    mockClaxedoState = {
      wb: {
        state: { panes: [] },
        selectors: {
          focusedContent: () => "tab-draft",
        },
      },
      meta: {
        get: () => ({
          id: "tab-draft",
          type: "draft-session",
          content: { type: "draft-session", draftId: "draft-1", providerDirectory: "/repo/main", title: "New Session" },
        }),
        patch: () => undefined,
        find: () => undefined,
        all: () => [],
      },
      layout: {
        openSession: (directory: string, sessionID: string, title: string) => {
          openCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        showContent: (id: string) => {
          showCalls.push(id)
        },
        closeContent: (id: string) => {
          closeCalls.push(id)
        },
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      draftId: () => "draft-1",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(closeCalls).toEqual(["tab-draft"])
    expect(navCalls).toEqual(["//repo/main/session/session-1"])
  })

  test("split-mode handoff still patches the draft tab even if focus shifts before the microtask", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "group-1",
      surfaceId: () => "tab-new",
      leafId: () => "leaf-1",
    }

    mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "group-1", contentId: "tab-new" }] },
        selectors: {
          focusedContent: () => "tab-new",
        },
      },
      meta: {
        get: () => ({
          id: "tab-new",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "new",
            title: "Session",
          },
        }),
        patch: (id: string, patch: Record<string, unknown>) => {
          patchCalls.push({ id, patch })
        },
        find: () => undefined,
        all: () => [],
      },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([
      {
        id: "tab-new",
        patch: {
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "session-1",
            title: "Session",
          },
        },
      },
      { id: "tab-new", patch: { sessionId: "session-1" } },
    ])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
  })
})
