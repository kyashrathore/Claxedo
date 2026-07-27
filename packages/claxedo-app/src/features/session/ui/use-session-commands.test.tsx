import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  clearConversationChatRegistryForTest,
  registerSessionConversationChat,
} from "../conversation/conversation-registry"
import type { ConversationChatHandle } from "../conversation/opencode-conversation"
import { queryClient } from "@/platform/query/query-client"
import { directorySessionCacheQueryOptions } from "../data/sync/queries"
import { workspaceSessionRoute } from "@/platform/identity/route"
import { composerFocus } from "../composer/ui/composer-focus"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeEach(() => configureAppPortsForTest())

const realGlobalSdkModule = { ...(await import(`${import.meta.dir}/../../../app/providers/global-sdk/provider.tsx?session-commands-restore`)) }
const realSelectModelModule = { ...(await import(`${import.meta.dir}/model/select-model.tsx?session-commands-restore`)) }

afterAll(() => {
  mock.module("@/app/providers/global-sdk/provider", () => realGlobalSdkModule)
  mock.module("@/features/session/ui/model/select-model", () => realSelectModelModule)
})

const testGlobal = globalThis as typeof globalThis & {
  React?: { createElement: (component: unknown, props: unknown) => unknown }
}
testGlobal.React = {
  createElement: (component, props) => typeof component === "function" ? component(props) : undefined,
}

const registered: Array<() => any[]> = []
const sdkCalls = {
  abort: 0,
  revert: 0,
  unrevert: 0,
  summarize: 0,
  share: [] as unknown[],
  unshare: [] as unknown[],
}

const params = {
  dir: "L3JlcG8=",
  id: "session-1",
}
let sessionInfo: { id: string; revert?: { messageID: string }; share?: { url?: string } } = { id: "session-1" }
let fileTreeToggles = 0
let mockClaxedoState: any
const reviewPanelCalls: unknown[] = []
const terminalOpenCalls: unknown[] = []
const terminalQueueCalls: unknown[] = []
const terminalCloseCalls: unknown[] = []
let focusInputCalls = 0
const promptSets: unknown[] = []
const navigateCalls: string[] = []
const dialogFactories: Array<() => unknown> = []
const localModelSetCalls: Array<{ model: unknown; options?: { recent?: boolean } }> = []
type CapturedPicker = {
  list: () => Array<{ id: string; provider: { id: string } }>
  set: (item: { providerID: string; modelID: string }, options?: { recent?: boolean }) => void
}
const modelDialogProps: Array<{ model?: CapturedPicker }> = []
const localModel = {
  list: () => [{ id: "model-1", name: "Model 1", provider: { id: "provider-1", name: "Provider 1" } }],
  current: () => ({ id: "model-1", name: "Model 1", provider: { id: "provider-1", name: "Provider 1" } }),
  visible: () => true,
  set: (model: unknown, options?: { recent?: boolean }) => {
    localModelSetCalls.push({ model, options })
  },
  variant: {
    current: () => undefined,
    cycle: () => undefined,
  },
}

function chat(messages: Array<{ id: string; role: "user" | "assistant" }> = []): ConversationChatHandle {
  return {
    messages: () =>
      messages.map((message) => ({
        ...message,
        parts: message.role === "user"
          ? [{ type: "text" as const, content: `${message.id} prompt`, metadata: { opencodePartId: `${message.id}-text` } }]
          : [],
      })),
    setMessages: () => undefined,
  }
}

function seedSessionChat() {
  registerSessionConversationChat("session-1", chat([
    { id: "msg-1", role: "user" },
    { id: "msg-2", role: "user" },
  ]))
}

function setSessionInfo(value: { id: string; revert?: { messageID: string }; share?: { url?: string } }) {
  sessionInfo = value
  queryClient.setQueryData(directorySessionCacheQueryOptions({ directory: "/repo" }).queryKey, {
    at: 1,
    limit: 5,
    total: 1,
    session: [value],
  })
}

mock.module("@solidjs/router", () => ({
  useNavigate: () => (path: string) => {
    navigateCalls.push(path)
  },
  useParams: () => params,
}))

mock.module("@/app/providers/command", () => ({
  useCommand: () => ({
    register: (_group: string, factory: () => any[]) => {
      registered.push(factory)
      return () => undefined
    },
  }),
}))

mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (factory: () => unknown) => {
      dialogFactories.push(factory)
    },
  }),
}))

mock.module("@/features/session/ui/dialogs/select-file", () => ({
  DialogSelectFile: () => undefined,
}))

mock.module("@/features/session/ui/model/select-model", () => ({
  ...realSelectModelModule,
  DialogSelectModel: (props: { model?: CapturedPicker }) => {
    modelDialogProps.push(props)
  },
}))

mock.module("@/features/session/ui/dialogs/select-mcp", () => ({
  DialogSelectMcp: () => undefined,
}))

mock.module("@/features/session/ui/dialogs/fork", () => ({
  DialogFork: () => undefined,
}))

mock.module("@/app/providers/file", () => ({
  useFile: () => ({
    get: () => undefined,
    pathFromTab: () => undefined,
    selectedLines: () => undefined,
  }),
  selectionFromLines: () => ({ startLine: 1, endLine: 1 }),
}))

mock.module("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

mock.module("@/app/providers/layout", () => ({
  getAvatarColors: () => ({
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }),
  useLayout: () => ({
    tabs: () => ({
      active: () => undefined,
      close: () => undefined,
    }),
    view: () => undefined,
    fileTree: {
      toggle: () => {
        fileTreeToggles += 1
      },
    },
  }),
}))

mock.module("@/features/session/providers/session-selection", () => ({
  useLocal: () => ({
    agent: {
      move: () => undefined,
    },
    model: localModel,
  }),
}))

mock.module("@/features/session/providers/permission", () => ({
  usePermission: () => ({
    permissionsEnabled: () => true,
    isAutoAccepting: () => false,
    isAutoAcceptingDirectory: () => false,
    toggleAutoAccept: () => undefined,
    toggleAutoAcceptDirectory: () => undefined,
  }),
}))

// Spread the real module: `mock.module` replaces the module PROCESS-WIDE, so
// later test files that import the pure exports (DEFAULT_PROMPT,
// isPromptEqual, …) would otherwise crash with "Export not found".
const realPrompt = await import("@/features/session/providers/prompt")
mock.module("@/features/session/providers/prompt", () => ({
  ...realPrompt,
  usePrompt: () => ({
    set: (value: unknown) => {
      promptSets.push(value)
    },
    reset: () => undefined,
    context: {
      add: () => undefined,
    },
  }),
}))

mock.module("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://localhost:4096",
    directory: "/repo",
    client: {
      config: {
        get: async () => ({ data: {} }),
      },
      session: {
        abort: async () => {
          sdkCalls.abort += 1
          return { data: undefined }
        },
        revert: async () => {
          sdkCalls.revert += 1
          return { data: undefined }
        },
        unrevert: async () => {
          sdkCalls.unrevert += 1
          return { data: undefined }
        },
        summarize: async () => {
          sdkCalls.summarize += 1
          return { data: undefined }
        },
      },
    },
  }),
}))

mock.module("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: () => ({
    client: {
      session: {
        share: async (input: unknown) => {
          sdkCalls.share.push(input)
          return { data: { share: { url: "https://share.test/session-1" } } }
        },
        unshare: async (input: unknown) => {
          sdkCalls.unshare.push(input)
          return { data: undefined }
        },
      },
    },
  }),
}))

mock.module("@/context/sync", () => ({
  mergeParts: (parts: Array<{ id: string }> | undefined, want: Array<{ id: string }>) => {
    if (!parts) return want.slice().sort((a, b) => a.id.localeCompare(b.id))
    const next = parts.slice().sort((a, b) => a.id.localeCompare(b.id))
    for (const part of want) {
      if (next.some((item) => item.id === part.id)) continue
      const index = next.findIndex((item) => item.id > part.id)
      next.splice(index === -1 ? next.length : index, 0, part)
    }
    return next
  },
  useSync: () => ({
    data: {
      session_status: { "session-1": { type: "idle" } },
    },
    session: {
      get: () => sessionInfo,
    },
  }),
}))

mock.module("@/app/workbench/state", () => ({
  realDirectory: (dir?: string | null) => (!dir || dir === "__process__" ? undefined : dir),
  useClaxedoState: () => {
    if (mockClaxedoState) return mockClaxedoState
    throw new Error("no claxedo state")
  },
}))

mock.module("@/platform/telemetry/analytics", () => ({
  capture: () => undefined,
}))

mock.module("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

function registeredCommands() {
  return registered.flatMap((factory) => factory())
}

describe("upstream contract", async () => {
  const { useSessionCommands } = await import("@/features/session/ui/use-session-commands")

  beforeEach(() => {
    registered.length = 0
    sdkCalls.abort = 0
    sdkCalls.revert = 0
    sdkCalls.unrevert = 0
    sdkCalls.summarize = 0
    sdkCalls.share = []
    sdkCalls.unshare = []
    queryClient.clear()
    setSessionInfo({ id: "session-1" })
    fileTreeToggles = 0
    mockClaxedoState = undefined
    reviewPanelCalls.length = 0
    terminalOpenCalls.length = 0
    terminalQueueCalls.length = 0
    promptSets.length = 0
    navigateCalls.length = 0
    dialogFactories.length = 0
    modelDialogProps.length = 0
    localModelSetCalls.length = 0
    clearConversationChatRegistryForTest()
    seedSessionChat()
  })

  const collectCommands = (capabilities = {
    transport: "opencode",
    abort: true,
    reconnect: false,
    replay: true,
    permissions: true,
    questions: true,
    todos: true,
    commands: true,
    fork: true,
    revert: true,
    unrevert: true,
    configOptions: false,
  }) => {
    let commands: any[] = []
    createRoot((dispose) => {
      useSessionCommands({
        sessionId: () => params.id,
        directory: () => "/repo",
        activeMessage: () => undefined,
        showAllFiles: () => undefined,
        navigateMessageByOffset: () => undefined,
        setExpanded: () => undefined,
        setActiveMessage: () => undefined,
        focusInput: () => undefined,
        status: () => ({ type: "idle" }),
        capabilities: () => capabilities,
      })

      commands = registeredCommands()
      dispose()
    })
    return commands
  }

  test("keeps upstream model, file, MCP, fork, and navigation commands registered", () => {
    const ids = collectCommands().map((command) => command.id)

    expect(ids).toContain("model.choose")
    expect(ids).toContain("file.open")
    expect(ids).toContain("mcp.toggle")
    expect(ids).toContain("session.fork")
    expect(ids).toContain("message.previous")
    expect(ids).toContain("message.next")
  })

  test("model picker command injects the local model controller", () => {
    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    byId.get("model.choose")?.onSelect()
    dialogFactories.at(-1)?.()

    expect(modelDialogProps.at(-1)?.model).toBeDefined()
    expect(modelDialogProps.at(-1)?.model).not.toBe(localModel)
    expect(modelDialogProps.at(-1)?.model?.list().map((item) => ({
      providerID: item.provider.id,
      modelID: item.id,
    }))).toEqual([{ providerID: "provider-1", modelID: "model-1" }])

    modelDialogProps.at(-1)?.model?.set({ providerID: "provider-1", modelID: "model-2" }, { recent: true })

    expect(localModelSetCalls).toEqual([{
      model: { providerID: "provider-1", modelID: "model-2" },
      options: { recent: true },
    }])
  })

  test("keeps upstream capability gating for disabled session actions", () => {
    const byId = new Map(collectCommands({
      transport: "codex-acp",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: false,
      questions: false,
      todos: true,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: true,
    }).map((command) => [command.id, command]))

    expect(byId.get("permissions.autoaccept")?.disabled).toBe(true)
    expect(byId.get("session.undo")?.disabled).toBe(true)
    expect(byId.get("session.redo")?.disabled).toBe(true)
    expect(byId.get("session.compact")?.disabled).toBe(true)
    expect(byId.get("session.fork")?.disabled).toBe(true)
  })

  test("new session command uses the typed workspace draft route", () => {
    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    byId.get("session.new")?.onSelect()

    expect(navigateCalls).toEqual([workspaceSessionRoute("/repo")])
  })

  test("keeps upstream redo enabled when a revert point exists", () => {
    setSessionInfo({ id: "session-1", revert: { messageID: "msg-1" } })

    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    expect(byId.get("session.redo")?.disabled).toBe(false)
  })

  // Claxedo drops upstream's session sharing: no `session.share`/`session.unshare`
  // command, and therefore no `/share` row in the composer's slash popover (which
  // lists every non-disabled command option carrying a `slash` trigger). A shared
  // session URL on the info record must not resurrect either one.
  test("registers no session share or unshare command", () => {
    setSessionInfo({ id: "session-1", share: { url: "https://share.test/session-1" } })

    const commands = collectCommands()
    const byId = new Map(commands.map((command) => [command.id, command]))

    expect(byId.has("session.share")).toBe(false)
    expect(byId.has("session.unshare")).toBe(false)
    expect(commands.filter((command) => command.slash === "share" || command.slash === "unshare")).toEqual([])
    expect(sdkCalls.share).toEqual([])
    expect(sdkCalls.unshare).toEqual([])
  })

  test("restores undo prompt from registered chat parts", async () => {
    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    await byId.get("session.undo")?.onSelect()

    expect(sdkCalls.revert).toBe(1)
    expect(promptSets).toEqual([[
      {
        type: "text",
        content: "msg-2 prompt",
        start: 0,
        end: 12,
      },
    ]])
  })
})

describe("Claxedo behavior", async () => {
  const { useSessionCommands } = await import("@/features/session/ui/use-session-commands")

  beforeEach(() => {
    registered.length = 0
    queryClient.clear()
    setSessionInfo({ id: "session-1" })
    fileTreeToggles = 0
    mockClaxedoState = undefined
    reviewPanelCalls.length = 0
    terminalOpenCalls.length = 0
    terminalQueueCalls.length = 0
    terminalCloseCalls.length = 0
    focusInputCalls = 0
    // `focusComposerWhenReady` gives up (without running its fallback) when
    // something other than BODY already holds focus, on the theory that the
    // user moved it. bun runs every test file in one process and one document,
    // so a node another file focused and never blurred would silently turn the
    // focus-handoff assertion below into a no-op — it failed exactly that way
    // under Linux file ordering. Hand each test a clean document.
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    document.body.innerHTML = ""
    composerFocus.schedule = (run) => run()
    promptSets.length = 0
    navigateCalls.length = 0
    clearConversationChatRegistryForTest()
    seedSessionChat()
  })

  const collectCommands = () => {
    let commands: any[] = []
    createRoot((dispose) => {
      useSessionCommands({
        sessionId: () => params.id,
        directory: () => "/repo",
        activeMessage: () => undefined,
        showAllFiles: () => undefined,
        navigateMessageByOffset: () => undefined,
        setExpanded: () => undefined,
        setActiveMessage: () => undefined,
        focusInput: () => {
          focusInputCalls += 1
        },
        status: () => ({ type: "idle" }),
      })

      commands = registeredCommands()
      dispose()
    })
    return new Map(commands.map((command) => [command.id, command]))
  }

  test("new session hands focus to the composer after navigating", () => {
    const byId = collectCommands()

    byId.get("session.new")?.onSelect()

    // Navigates to the draft route AND schedules a composer focus handoff. With
    // no live composer node in the test DOM the handoff falls back to focusInput,
    // proving the command no longer leaves focus stranded on BODY.
    expect(navigateCalls).toEqual([workspaceSessionRoute("/repo")])
    expect(focusInputCalls).toBe(1)
  })

  test("terminal.toggle opens a real Workbench terminal when none is focused", () => {
    mockClaxedoState = {
      wb: {
        state: { focusedPaneId: "pane-1" },
        selectors: { focusedContent: () => "content-1" },
      },
      meta: new Map([["content-1", { id: "content-1", type: "session", directory: "/repo/pane" }]]),
      workspace: {
        paneWorktree: () => ({ pinned: "/repo/pinned", default: "/repo/default" }),
      },
      workspacePanel: { close: () => undefined },
      layout: {
        openTerminal: (...input: unknown[]) => {
          terminalOpenCalls.push(input)
          return "terminal-content"
        },
        closeContent: (...input: unknown[]) => terminalCloseCalls.push(input),
      },
      terminal: {
        queueCreateForContent: (...input: unknown[]) => terminalQueueCalls.push(input),
      },
    }

    const byId = collectCommands()
    byId.get("terminal.toggle")?.onSelect()

    expect(terminalOpenCalls[0]?.[0]).toBe("/repo/pane")
    expect(terminalQueueCalls[0]?.[0]).toBe("terminal-content")
    expect(terminalQueueCalls[0]?.[1]).toBe("/repo/pane")
    expect(terminalCloseCalls).toEqual([])
    expect(navigateCalls.at(-1)).toMatch(/^\/w\/%2Frepo%2Fpane\/terminal\/pending-/)
  })

  test("terminal.toggle closes the focused terminal instead of opening another", () => {
    mockClaxedoState = {
      wb: {
        state: { focusedPaneId: "pane-1" },
        selectors: { focusedContent: () => "term-1" },
      },
      meta: new Map([["term-1", { id: "term-1", type: "terminal", directory: "/repo/pane", terminalId: "pty-1" }]]),
      workspace: {
        paneWorktree: () => ({ pinned: "/repo/pinned", default: "/repo/default" }),
      },
      workspacePanel: { close: () => undefined },
      layout: {
        openTerminal: (...input: unknown[]) => {
          terminalOpenCalls.push(input)
          return "terminal-content"
        },
        closeContent: (...input: unknown[]) => terminalCloseCalls.push(input),
      },
      terminal: {
        queueCreateForContent: (...input: unknown[]) => terminalQueueCalls.push(input),
      },
    }

    const byId = collectCommands()
    byId.get("terminal.toggle")?.onSelect()

    expect(terminalCloseCalls).toEqual([["term-1", "user"]])
    expect(terminalOpenCalls).toEqual([])
    expect(terminalQueueCalls).toEqual([])
  })

  test("fileTree.toggle uses Claxedo split-safe keybind", () => {
    const byId = collectCommands()
    const command = byId.get("fileTree.toggle")

    expect(command?.keybind).toBe("mod+shift+e")
    command?.onSelect()
    expect(fileTreeToggles).toBe(1)
  })

  test("terminal.new and review.toggle target the focused Workbench pane", () => {
    mockClaxedoState = {
      wb: {
        state: { focusedPaneId: "pane-1" },
        selectors: { focusedContent: () => "content-1" },
      },
      meta: new Map([["content-1", { directory: "/repo/pane" }]]),
      workspace: {
        paneWorktree: () => ({ pinned: "/repo/pinned", default: "/repo/default" }),
      },
      workspacePanel: {
        close: () => undefined,
        toggle: (input: unknown) => reviewPanelCalls.push(input),
      },
      layout: {
        openTerminal: (...input: unknown[]) => {
          terminalOpenCalls.push(input)
          return "terminal-content"
        },
      },
      terminal: {
        queueCreateForContent: (...input: unknown[]) => terminalQueueCalls.push(input),
      },
    }

    const byId = collectCommands()

    byId.get("review.toggle")?.onSelect()
    expect(reviewPanelCalls).toEqual([{
      workspaceDir: "/repo/pane",
      targetPaneId: "pane-1",
      navigator: null,
      focus: null,
    }])

    byId.get("terminal.new")?.onSelect()
    expect(terminalOpenCalls[0]?.[0]).toBe("/repo/pane")
    expect(terminalQueueCalls[0]?.[0]).toBe("terminal-content")
    expect(terminalQueueCalls[0]?.[1]).toBe("/repo/pane")
    expect(terminalQueueCalls[0]?.[4]).toBe("pane-1")
    expect(navigateCalls.at(-1)).toMatch(/^\/w\/%2Frepo%2Fpane\/terminal\/pending-/)
  })
})
