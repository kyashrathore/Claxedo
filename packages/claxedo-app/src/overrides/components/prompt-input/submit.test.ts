import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
const calls = { prompt: 0, async: 0 }

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@claxedo/utils/api", () => ({
    isDemoMode: () => true,
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
      reset: () => undefined,
      set: () => undefined,
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
        setTabs: () => undefined,
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
          create: async () => ({ data: { id: "session-1" } }),
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
          create: async () => ({ data: { id: "session-1" } }),
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
          add: () => undefined,
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
      throw new Error("no session params")
    },
  }))

  mock.module("../../../claxedo-ui/context/claxedo-layout", () => ({
    useClaxedoLayout: () => {
      throw new Error("no claxedo layout")
    },
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  calls.prompt = 0
  calls.async = 0
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
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.prompt).toBe(1)
    expect(calls.async).toBe(0)
  })
})
