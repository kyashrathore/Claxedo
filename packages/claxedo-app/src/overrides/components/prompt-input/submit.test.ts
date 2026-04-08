import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
const calls = { prompt: 0, async: 0, create: 0 }
const boots: Array<{ runner: string; sessionID?: string } | undefined> = []
const navCalls: string[] = []
const handoffCalls: Array<{ dir: string; sessionID: string }> = []
const promptCalls = {
  reset: [] as Array<unknown>,
  set: [] as Array<{ prompt: Prompt; cursor?: number; scope?: unknown }>,
}
const optimisticAdds: Array<{ directory?: string; sessionID: string }> = []
let demoMode = true
let acpMode = false
let mockClaxedoLayout: any
let mockSessionParams:
  | {
      sessionId: () => string | undefined
      directory: () => string
      groupId: () => string | undefined
      tabId: () => string | undefined
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
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@claxedo/utils/api", () => ({
    isDemoMode: () => demoMode,
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

  mock.module("../../../claxedo-ui/context/claxedo-layout", () => ({
    useClaxedoLayout: () => {
      if (mockClaxedoLayout) return mockClaxedoLayout
      throw new Error("no claxedo layout")
    },
  }))

  mock.module("../../../claxedo-ui/context/acp-config", () => ({
    acpScope: () => "scope",
    useAcpConfig: () => ({
      isAcpMode: () => acpMode,
      acpModelForSubmit: () => (acpMode ? { id: "opus", name: "Opus", provider: { id: "claude-acp" } } : undefined),
      claimSession: async () => (acpMode ? { id: "session-1" } : undefined),
      displayName: () => "Claude",
      runner: () => "claude-acp",
      selectedModel: () => "opus",
      promote: () => undefined,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  calls.prompt = 0
  calls.async = 0
  calls.create = 0
  boots.length = 0
  navCalls.length = 0
  handoffCalls.length = 0
  promptCalls.reset = []
  promptCalls.set = []
  optimisticAdds.length = 0
  demoMode = true
  acpMode = false
  mockClaxedoLayout = undefined
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
    expect(calls.async).toBe(1)
    expect(boots).toEqual([
      { runner: "Claude", sessionID: undefined },
      { runner: "Claude", sessionID: "session-1" },
    ])
  })

  test("clears the original draft scope after creating a new session", async () => {
    demoMode = false

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

    expect(promptCalls.reset).toEqual([{ dir: "/repo/main", id: "new" }])
  })

  test("reuses the active new-session tab when the first prompt creates a real session", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const addCalls: Array<{ directory: string; sessionID: string; title: string }> = []
    const setActiveCalls: string[] = []

    mockClaxedoLayout = {
      split: {
        groups: () => [],
        active: () => false,
      },
      topTabs: {
        active: () => ({
          id: "tab-new",
          type: "session",
          directory: "/repo/main",
          sessionId: "new",
          title: "New Session",
          closable: true,
        }),
        patch: (id, patch) => {
          patchCalls.push({ id, patch })
        },
        findSession: () => undefined,
        addSession: (directory, sessionID, title) => {
          addCalls.push({ directory, sessionID, title })
          return "tab-added"
        },
        setActive: (id) => {
          setActiveCalls.push(id)
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

    expect(patchCalls).toEqual([{ id: "tab-new", patch: { sessionId: "session-1", title: "Session" } }])
    expect(addCalls).toEqual([])
    expect(setActiveCalls).toEqual(["tab-new"])
    expect(handoffCalls).toEqual([{ dir: "/repo/main", sessionID: "session-1" }])
    expect(navCalls).toEqual(["//repo/main/session/session-1"])
  })

  test("split-mode handoff still patches the draft tab even if focus shifts before the microtask", async () => {
    demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const setContentCalls: Array<{ tabId: string; leafId: string; content: Record<string, unknown> }> = []
    let seen = 0
    mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      groupId: () => "group-1",
      tabId: () => "tab-new",
      leafId: () => "leaf-1",
    }

    mockClaxedoLayout = {
      split: {
        groups: () => [{ id: "group-1" }],
        active: () => true,
      },
      groupTabs: () => ({
        items: () => [],
        active: () => {
          seen += 1
          if (seen === 1) {
            return {
              id: "tab-new",
              type: "session",
              directory: "/repo/main",
              sessionId: "new",
              title: "New Session",
              closable: true,
            }
          }
          return {
            id: "tab-other",
            type: "session",
            directory: "/repo/main",
            sessionId: "other",
            title: "Other",
            closable: true,
          }
        },
        patch: (id: string, patch: Record<string, unknown>) => {
          patchCalls.push({ id, patch })
        },
      }),
      multiPane: {
        activeLayout: () => ({
          contents: {
            "leaf-1": {
              type: "session",
              directory: "/repo/main",
              sessionId: "new",
              title: "Session",
            },
          },
        }),
        setContent: (tabId: string, leafId: string, content: Record<string, unknown>) => {
          setContentCalls.push({ tabId, leafId, content })
        },
      },
      topTabs: {
        active: () => undefined,
        patch: () => undefined,
        findSession: () => undefined,
        addSession: () => "tab-added",
        setActive: () => undefined,
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

    expect(setContentCalls).toEqual([
      {
        tabId: "tab-new",
        leafId: "leaf-1",
        content: {
          type: "session",
          directory: "/repo/main",
          sessionId: "session-1",
          title: "Session",
        },
      },
    ])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
    expect(patchCalls).toEqual([{ id: "tab-new", patch: { sessionId: "session-1", title: "Session" } }])
  })
})
