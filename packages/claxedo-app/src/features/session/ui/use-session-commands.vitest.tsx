import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot, createSignal } from "solid-js"
import {
  clearConversationChatRegistryForTest,
  registerSessionConversationChat,
} from "../conversation/conversation-registry"
import type { ConversationChatHandle } from "../conversation/agent-conversation"
import { queryClient } from "@/platform/query/query-client"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../data/sync/queries"
import { workspaceSessionRoute } from "@/platform/identity/route"
import { composerFocus } from "../composer/ui/composer-focus"

const realSelectModelModule = { ...(await import("./model/select-model")) }
const originalFocusSchedule = composerFocus.schedule
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  composerFocus.schedule = originalFocusSchedule
  queryClient.clear()
  clearConversationChatRegistryForTest()
})

const registered: Array<() => any[]> = []
const sdkCalls = {
  abort: 0,
  revert: 0,
  unrevert: 0,
  summarize: 0,
}

const params = {
  dir: "L3JlcG8=",
  id: "session-1",
}
let fileTreeToggles = 0
let mockClaxedoState: any
let activeTab: string | undefined
let filePathFromTab: (tab: string) => string | undefined = () => undefined
let fileSelectedLines: (path: string) => unknown = () => undefined
const captured: Array<{ event: string; properties: Record<string, unknown> }> = []
const reviewPanelCalls: unknown[] = []
const terminalOpenCalls: unknown[] = []
const terminalQueueCalls: unknown[] = []
const terminalCloseCalls: unknown[] = []
let focusInputCalls = 0
const promptSets: unknown[] = []
const navigateCalls: string[] = []
const dialogFactories: Array<() => unknown> = []
const fileDialogProps: Array<{ mode?: "all" | "files"; directory: string; sessionId?: string }> = []
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
          ? [{ type: "text" as const, content: `${message.id} prompt`, metadata: { agentPartId: `${message.id}-text` } }]
          : [],
      })),
    setMessages: () => undefined,
  }
}

function seedSessionChat() {
  registerSessionConversationChat({ directory: "/repo", sessionID: "session-1" }, chat([
    { id: "msg-1", role: "user" },
    { id: "msg-2", role: "user" },
  ]))
}

function setSessionInfo(value: { id: string; revert?: { messageID: string }; share?: { url?: string } }) {
  queryClient.setQueryData(directorySessionCacheQueryOptions({ directory: "/repo" }).queryKey, {
    at: 1,
    limit: 5,
    total: 1,
    session: [value],
  })
}

vi.doMock("@solidjs/router", () => ({
  useNavigate: () => (path: string) => {
    navigateCalls.push(path)
  },
  useParams: () => params,
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
}))

vi.doMock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (factory: () => unknown) => {
      dialogFactories.push(factory)
    },
  }),
}))

vi.doMock("@/features/session/ui/dialogs/select-file", () => ({
  DialogSelectFile: (props: { mode?: "all" | "files"; directory: string; sessionId?: string }) => {
    fileDialogProps.push(props)
  },
}))

vi.doMock("@/features/session/ui/model/select-model", () => ({
  ...realSelectModelModule,
  DialogSelectModel: (props: { model?: CapturedPicker }) => {
    modelDialogProps.push(props)
  },
}))

vi.doMock("@/features/session/ui/dialogs/fork", () => ({
  DialogFork: () => undefined,
}))

vi.doMock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.doMock("@/features/session/providers/session-selection", () => ({
  useLocal: () => ({
    agent: {
      move: () => undefined,
    },
    model: localModel,
  }),
}))

vi.doMock("@/features/session/providers/permission", () => ({
  usePermission: () => ({
    permissionsEnabled: () => true,
    isAutoAccepting: () => false,
    isAutoAcceptingDirectory: () => false,
    toggleAutoAccept: () => undefined,
    toggleAutoAcceptDirectory: () => undefined,
  }),
}))

const realPrompt = await import("@/features/session/providers/prompt")
vi.doMock("@/features/session/providers/prompt", () => ({
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

vi.doMock("@/platform/telemetry/analytics", () => ({
  capture: (event: string, properties: Record<string, unknown>) => {
    captured.push({ event, properties })
  },
  identityProps: () => ({ org_id: "anon", user_id: "anon", deployment_mode: "self-host" }),
}))

vi.doMock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

const owners: Array<{ isVisible: () => boolean; isFocused: () => boolean } | undefined> = []

vi.doMock("@/features/session/app-ports", () => ({
  useCommand: () => ({
    register: (_group: string, factory: () => any[], opts?: { owner?: { isVisible: () => boolean; isFocused: () => boolean } }) => {
      registered.push(factory)
      owners.push(opts?.owner)
      return () => undefined
    },
  }),
  useFile: () => ({
    get: () => undefined,
    pathFromTab: (tab: string) => filePathFromTab(tab),
    selectedLines: (path: string) => fileSelectedLines(path),
  }),
  selectionFromLines: () => ({ startLine: 1, endLine: 1 }),
  getAvatarColors: () => ({
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }),
  useLayout: () => ({
    tabs: () => ({
      active: () => activeTab,
      close: () => undefined,
    }),
    view: () => undefined,
    fileTree: {
      toggle: () => {
        fileTreeToggles += 1
      },
    },
  }),
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
          return { data: { id: "session-1", time: { created: 1, updated: 2 } } }
        },
        summarize: async () => {
          sdkCalls.summarize += 1
          return { data: undefined }
        },
      },
    },
  }),
  realDirectory: (dir?: string | null) => (!dir || dir === "__process__" ? undefined : dir),
  useClaxedoState: () => {
    if (mockClaxedoState) return mockClaxedoState
    throw new Error("no claxedo state")
  },
  loadManageModelsDialog: async () => ({ DialogManageModels: () => null }),
  openSettingsProviders: vi.fn(),
}))

const { registerSessionCommands, useSessionCommands } = await import("./use-session-commands")

function registeredCommands() {
  return registered.flatMap((factory) => factory())
}

async function renderLatestDialog(until: () => boolean) {
  const factory = dialogFactories.at(-1)
  if (!factory) throw new Error("Expected a dialog factory")
  let dispose = () => undefined
  createRoot((rootDispose) => {
    dispose = rootDispose
    factory()
  })
  try {
    const deadline = Date.now() + 1_000
    while (!until() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (!until()) throw new Error("Lazy dialog did not resolve")
  } finally {
    dispose()
  }
}

describe("session command contracts", () => {

  beforeEach(() => {
    registered.length = 0
    sdkCalls.abort = 0
    sdkCalls.revert = 0
    sdkCalls.unrevert = 0
    sdkCalls.summarize = 0
    queryClient.clear()
    setSessionInfo({ id: "session-1" })
    fileTreeToggles = 0
    mockClaxedoState = undefined
    activeTab = undefined
    filePathFromTab = () => undefined
    fileSelectedLines = () => undefined
    captured.length = 0
    reviewPanelCalls.length = 0
    terminalOpenCalls.length = 0
    terminalQueueCalls.length = 0
    promptSets.length = 0
    navigateCalls.length = 0
    dialogFactories.length = 0
    fileDialogProps.length = 0
    modelDialogProps.length = 0
    localModelSetCalls.length = 0
    clearConversationChatRegistryForTest()
    seedSessionChat()
  })

  const collectCommands = (capabilities = {
    transport: "runtime",
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
        active: () => true,
        sessionId: () => params.id,
        directory: () => "/repo",
        workspaceRouteId: (directory) => directory === "/repo/pane" ? "ws_pane" : "ws_repo",
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
      disposers.push(dispose)
    })
    return commands
  }

  test("keeps upstream model, file, fork, and navigation commands registered", () => {
    const ids = collectCommands().map((command) => command.id)

    expect(ids).toContain("model.choose")
    expect(ids).toContain("file.open")
    expect(ids).toContain("mcp.toggle")
    expect(ids).toContain("session.fork")
    expect(ids).toContain("message.previous")
    expect(ids).toContain("message.next")
  })

  test("the MCP command answers to /mcp and mod+;", () => {
    const mcp = collectCommands().find((command) => command.id === "mcp.toggle")

    expect(mcp).toMatchObject({
      keybind: "mod+;",
      slash: "mcp",
      category: "command.category.mcp",
    })
  })

  test("scopes Open File to files while the command palette keeps the combined mode", async () => {
    const fileOpen = collectCommands().find((command) => command.id === "file.open")

    fileOpen?.onSelect("keybind")
    await renderLatestDialog(() => fileDialogProps.length === 1)
    expect(fileDialogProps.at(-1)).toMatchObject({ mode: "files", directory: "/repo", sessionId: "session-1" })

    fileOpen?.onSelect("palette")
    await renderLatestDialog(() => fileDialogProps.length === 2)
    expect(fileDialogProps.at(-1)).toMatchObject({ mode: "all", directory: "/repo", sessionId: "session-1" })
  })

  test("model picker command injects the local model controller", async () => {
    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    byId.get("model.choose")?.onSelect()
    await renderLatestDialog(() => modelDialogProps.length === 1)

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

    expect(navigateCalls).toEqual([workspaceSessionRoute("ws_repo")])
  })

  test("keeps upstream redo enabled when a revert point exists", () => {
    setSessionInfo({ id: "session-1", revert: { messageID: "msg-1" } })

    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    expect(byId.get("session.redo")?.disabled).toBe(false)
  })

  test("clears the cached revert point after the authoritative unrevert response", async () => {
    setSessionInfo({ id: "session-1", revert: { messageID: "msg-2" } })
    const byId = new Map(collectCommands().map((command) => [command.id, command]))

    await byId.get("session.redo")?.onSelect()

    expect(sdkCalls.unrevert).toBe(1)
    expect(queryClient.getQueryData<DirectorySessionCacheValue>(
      directorySessionCacheQueryOptions({ directory: "/repo" }).queryKey,
    )?.session[0]?.revert).toBeUndefined()
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

describe("Claxedo behavior", () => {

  test("a session page outside the workbench serves commands only while it is active", () => {
    const [active, setActive] = createSignal(false)
    owners.length = 0
    createRoot((dispose) => {
      useSessionCommands({
        active,
        sessionId: () => "session-1",
        directory: () => "/repo",
        workspaceRouteId: () => undefined,
        activeMessage: () => undefined,
        showAllFiles: () => undefined,
        navigateMessageByOffset: () => undefined,
        setExpanded: () => undefined,
        setActiveMessage: () => undefined,
        focusInput: () => undefined,
        status: () => ({ type: "idle" }),
      })
      const owner = owners.at(-1)
      expect(owner).toBeDefined()
      expect(owner!.isVisible() && owner!.isFocused()).toBe(false)
      setActive(true)
      expect(owner!.isVisible() && owner!.isFocused()).toBe(true)
      dispose()
    })
  })

  test("a session page in a workbench slot hands the slot to the registry as its owner", () => {
    const slot = { isVisible: () => true, isFocused: () => false }
    owners.length = 0
    createRoot((dispose) => {
      useSessionCommands({
        active: () => true,
        owner: slot,
        sessionId: () => "session-1",
        directory: () => "/repo",
        workspaceRouteId: () => undefined,
        activeMessage: () => undefined,
        showAllFiles: () => undefined,
        navigateMessageByOffset: () => undefined,
        setExpanded: () => undefined,
        setActiveMessage: () => undefined,
        focusInput: () => undefined,
        status: () => ({ type: "idle" }),
      })
      expect(owners.at(-1)).toBe(slot)
      dispose()
    })
  })

  test("registers unconditionally and leaves ownership to the registry", () => {
    let registered: (() => { id: string }[]) | undefined
    const dispose = createRoot((rootDispose) => {
      registerSessionCommands({
        commands: () => [{ id: "owned", title: "Owned", onSelect: () => undefined }],
        register: (factory) => {
          registered = factory
        },
      })
      return rootDispose
    })

    expect(registered?.()[0]?.id).toBe("owned")
    dispose()
  })

  test("defers only the first command build to the scheduled install", () => {
    let scheduled: (() => void) | undefined
    let registered: (() => { id: string }[]) | undefined
    const dispose = createRoot((rootDispose) => {
      registerSessionCommands({
        commands: () => [{ id: "owned", title: "Owned", onSelect: () => undefined }],
        register: (factory) => {
          registered = factory
        },
        scheduleInitial: (install) => {
          scheduled = install
          return () => {
            scheduled = undefined
          }
        },
      })
      return rootDispose
    })

    expect(registered?.()).toEqual([])
    scheduled?.()
    expect(registered?.()[0]?.id).toBe("owned")
    dispose()
  })

  beforeEach(() => {
    registered.length = 0
    queryClient.clear()
    setSessionInfo({ id: "session-1" })
    fileTreeToggles = 0
    mockClaxedoState = undefined
    activeTab = undefined
    filePathFromTab = () => undefined
    fileSelectedLines = () => undefined
    captured.length = 0
    reviewPanelCalls.length = 0
    terminalOpenCalls.length = 0
    terminalQueueCalls.length = 0
    terminalCloseCalls.length = 0
    focusInputCalls = 0
    // The focus handoff is allowed only while the document has no other
    // focused control; model that initial user state explicitly.
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
        active: () => true,
        sessionId: () => params.id,
        directory: () => "/repo",
        workspaceRouteId: (directory) => directory === "/repo/pane" ? "ws_pane" : "ws_repo",
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
      disposers.push(dispose)
    })
    return new Map(commands.map((command) => [command.id, command]))
  }

  test("context.addSelection reports an extension and a hash, never the path", () => {
    const path = "/Users/ada/work/secret-client/src/features/billing/invoice.tsx"
    activeTab = "file:invoice"
    filePathFromTab = () => path
    fileSelectedLines = () => ({ start: 3, end: 9 })

    collectCommands().get("context.addSelection")?.onSelect()

    const event = captured.find((entry) => entry.event === "context_selection_added")
    expect(event?.properties.extension).toBe("tsx")
    expect(typeof event?.properties.path_hash).toBe("string")
    expect(event?.properties.path).toBeUndefined()
    // No value may carry a path fragment, a directory name, or the basename.
    const values = Object.values(event?.properties ?? {}).map(String)
    expect(values.some((value) => value.includes("/"))).toBe(false)
    expect(values.some((value) => value.includes("invoice"))).toBe(false)
    expect(values.some((value) => value.includes("secret-client"))).toBe(false)
  })

  test("new session hands focus to the composer after navigating", () => {
    const byId = collectCommands()

    byId.get("session.new")?.onSelect()

    // Navigates to the draft route AND schedules a composer focus handoff. With
    // no live composer node in the test DOM the handoff falls back to focusInput,
    // proving the command no longer leaves focus stranded on BODY.
    expect(navigateCalls).toEqual([workspaceSessionRoute("ws_repo")])
    expect(focusInputCalls).toBe(1)
  })

  test("terminal.toggle requests a Workbench terminal when none is focused", () => {
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
    expect(terminalOpenCalls[0]?.[3]).toMatchObject({ workspaceRouteId: "ws_pane" })
    expect(terminalQueueCalls[0]?.[0]).toBe("terminal-content")
    expect(terminalQueueCalls[0]?.[1]).toBe("/repo/pane")
    expect(terminalCloseCalls).toEqual([])
    expect(navigateCalls.at(-1)).toMatch(/^\/w\/ws_pane\/terminal\/pending-/)
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
    expect(terminalOpenCalls[0]?.[3]).toMatchObject({ workspaceRouteId: "ws_pane" })
    expect(terminalQueueCalls[0]?.[0]).toBe("terminal-content")
    expect(terminalQueueCalls[0]?.[1]).toBe("/repo/pane")
    expect(terminalQueueCalls[0]?.[4]).toBe("pane-1")
    expect(navigateCalls.at(-1)).toMatch(/^\/w\/ws_pane\/terminal\/pending-/)
  })
})
