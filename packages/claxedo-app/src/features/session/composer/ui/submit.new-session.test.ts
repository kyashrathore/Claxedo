import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { promptScopeKey } from "./submit-prompt-scope"
import * as h from "./submit.harness.test"

const {
  createSubmit, createPromptSubmit, submitEvent, settleSubmitEffects, waitForSubmitEffect,
  seedProjectCatalog, seedCommandList, sessionStatusFor, localSessionRef, promptLengthForTest,
  repoMainPromptScope, promptValue, state, calls, boots, apiCalls, fetchCalls, unsignedCalls,
  runtimeCalls, transportPromptAsyncCalls, sessionCreateCalls, transportClients, harnessSetCalls,
  buildRequestPartCalls, shellCalls, commandCalls, navCalls, flowEvents, handoffCalls, toasts,
  promptCalls, optimisticAdds, optimisticRemoves, promptContextItems, promptContextAdds,
  promptContextRemoves, refreshCalls, bootstrapCalls, worktreeCreateCalls, enabledAutoAccept,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("New-session creation: cloud, worktree, and tab handoff", () => {
  test("clears the visible workspace draft after creating a new session", async () => {
    state.demoMode = false

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

      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    // clearInput resets RAW {dir, id} scopes — `pick`/`promptScopeKey` applies
    // `sessionViewKey` exactly once, resolving each to the same persist key the
    // composer reads (the draft slot before creation, the session slot after).
    // Pre-computing the key inside the scope would double-wrap it and leave the
    // just-sent text in the composer.
    expect(promptCalls.reset).toEqual([
      { dir: "/repo/main", id: "new" },
      { dir: "/repo/main", id: "session-1" },
    ])
    expect(promptCalls.reset.map((scope) => promptScopeKey(scope))).toEqual([
      repoMainPromptScope,
      "workspace:%2Frepo%2Fmain:session:session-1",
    ])
    expect(sessionCreateCalls.at(-1)?.options?.headers?.["x-claxedo-draft-id"]).toBe("draft-1")
  })


  test("unattached drafts refuse to create a session from the sdk directory fallback", async () => {
    state.demoMode = false

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

    await submit.handleSubmit(submitEvent())
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


  test("cloud new button creates a cloud workspace before the first prompt and reports startup", async () => {
    state.demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    let resetCalls = 0

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onNewSessionWorktreeReset: () => {
        resetCalls += 1
      },
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-1" })
    expect(bootstrapCalls).toEqual(["bootstrap"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/workspace/resolve")
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/workspace/ws_1/connection")
    expect(startup.some((item) => item.status === "acquiring_sandbox" && item.id === "ws_1")).toBe(true)
    expect(startup.some((item) => item.status === "ready")).toBe(true)
    expect(startup.some((item) => item.status === "loading_models")).toBe(true)
    expect(startup.some((item) => item.status === "creating_session")).toBe(true)
    expect(startup.some((item) => item.status === "sending_prompt")).toBe(true)
    expect(startup.at(-1)).toEqual({ status: undefined, id: undefined, err: undefined })
    expect(resetCalls).toBe(0)
  })


  test("cloud create preserves selected model instead of replacing it with runtime fallback", async () => {
    state.demoMode = false
    state.localCurrentModel = { id: "gpt-5.5-pro", provider: { id: "openai" } }
    state.runtimeProviderResponse = {
      all: [
        { id: "openai", models: { "gpt-5.5-pro": { id: "gpt-5.5-pro" } } },
        { id: "google", models: { "gemini-3-pro-image-preview": { id: "gemini-3-pro-image-preview", name: "Nano Banana Pro" } } },
      ],
      connected: ["google"],
      default: { google: "gemini-3-pro-image-preview" },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const configCall = runtimeCalls.find((call) =>
      call.input === "/session/session-1/config?directory=ws_1&harness=opencode"
    )
    expect(configCall?.method).toBe("PATCH")
    expect(JSON.parse(configCall?.body ?? "{}")).toMatchObject({
      harness: { type: "opencode" },
      model: { providerID: "openai", modelID: "gpt-5.5-pro" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-5.5-pro" },
    })
  })


  test("cloud create resolves model from workspace runtime providers when no model is selected", async () => {
    state.demoMode = false
    state.claxedoServerUrl = "https://claxedo.example"
    state.localCurrentModel = undefined
    state.runtimeProviderResponse = {
      all: [
        { id: "google", models: { "gemini-3-pro-image-preview": { name: "Nano Banana Pro" } } },
        { id: "opencode", models: { "deepseek-v4-flash-free": { name: "DeepSeek V4 Flash" } } },
      ],
      connected: ["google", "opencode"],
      default: { google: "gemini-3-pro-image-preview", opencode: "deepseek-v4-flash-free" },
    }

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: promptLengthForTest,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(runtimeCalls.some((call) => call.input.startsWith("/provider?"))).toBe(true)
    const configCall = runtimeCalls.find((call) =>
      call.input === "/session/session-1/config?directory=ws_1&harness=opencode"
    )
    expect(configCall?.method).toBe("PATCH")
    // `opencode` is the zero-key gateway and is connected everywhere, so the
    // credentialed provider (google) supplies the model — see model-strategy.
    expect(JSON.parse(configCall?.body ?? "{}")).toMatchObject({
      harness: { type: "opencode" },
      model: { providerID: "google", modelID: "gemini-3-pro-image-preview" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "google", modelID: "gemini-3-pro-image-preview" },
    })
  })


  test("cloud create retargets the active new-session tab to the created workspace", async () => {
    state.demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    state.mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "pane-1",
      surfaceId: () => "tab-new",
      leafId: () => "tab-new",
    }

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []

    state.mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "pane-1" }] },
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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => flowEvents.some((item) => item === "navigate:/w/ws_1/session/session-1"))

    expect(patchCalls).toEqual([])
    expect(openCalls).toEqual([{ directory: "ws_1", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(startup.some((item) => item.status === "opening_session")).toBe(true)
    expect(flowEvents.indexOf("optimistic:session-1")).toBeLessThan(flowEvents.indexOf("navigate:/w/ws_1/session/session-1"))
  })


  test("cloud startup stays open with the relay error when the first prompt fails", async () => {
    state.demoMode = false
    state.transportPromptAsyncError = new Error("Workspace connection failed: 401")
    const startup: Array<{ status?: string; id?: string; err?: string }> = []
    promptContextItems.push(
      {
        key: "file-comment",
        type: "file",
        path: "src/app.ts",
        comment: "check this",
        commentID: "comment-1",
        commentOrigin: "file",
      },
      {
        key: "page-comment",
        type: "file",
        path: "https://example.test/page",
        comment: "inspect this page",
        commentID: "comment-2",
        commentOrigin: "review",
      },
    )

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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(startup.some((item) => item.status === "ready")).toBe(true)
    expect(startup.at(-1)).toEqual({
      status: "error",
      id: undefined,
      err: "Workspace connection failed: 401",
    })
    expect(toasts).toContainEqual({
      title: "prompt.toast.promptSendFailed.title",
      description: "Workspace connection failed: 401",
    })
    expect(sessionStatusFor("ws_1", "session-1")).toEqual({ type: "idle" })
    expect(optimisticRemoves).toHaveLength(1)
    expect(optimisticRemoves[0]).toMatchObject({ directory: "ws_1", sessionID: "session-1" })
    expect(promptContextRemoves).toEqual(["file-comment", "page-comment"])
    expect(promptContextAdds).toEqual([
      {
        type: "file",
        path: "src/app.ts",
        comment: "check this",
        commentID: "comment-1",
        commentOrigin: "file",
      },
      {
        type: "file",
        path: "https://example.test/page",
        comment: "inspect this page",
        commentID: "comment-2",
        commentOrigin: "review",
      },
    ])
    expect(promptCalls.set.at(-1)?.prompt).toBe(promptValue)
    expect(promptCalls.set.at(-1)?.cursor).toBe(5)
  })


  test("cloud create resolves project id from global project catalog when directory sync is not attached yet", async () => {
    state.demoMode = false
    state.syncProject = undefined
    state.globalProjects = [{
      id: "project-formlink",
      worktree: "/repo/formlink",
      sandboxes: [],
      workspaces: { "/repo/formlink": { kind: "local" } },
    }]
    seedProjectCatalog()

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/formlink",
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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-formlink" })
    expect(toasts.find((toast) => toast.title === "Failed to create cloud workspace")).toBeUndefined()
  })


  test("local create selection creates a worktree before the first prompt", async () => {
    state.demoMode = false

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
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "local",
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(worktreeCreateCalls).toEqual([{ directory: "/repo/main" }])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "/repo/main/new",
      sessionID: "session-1",
    })

    const { Worktree } = await import("@/platform/sync/worktree")
    Worktree.ready("/repo/main/new")
    await new Promise<void>((r) => setTimeout(r, 0))
  })


  test("local existing-worktree selection stays local and never calls cloud create", async () => {
    state.demoMode = false
    state.syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["/repo/local-feature"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "/repo/local-feature": { kind: "local" },
      },
    }
    state.globalProjects = [state.syncProject]
    seedProjectCatalog()

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      newSessionWorktree: () => "/repo/local-feature",
      newSessionWorkspaceKind: () => "local",
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(worktreeCreateCalls).toEqual([])
    expect(optimisticAdds.map((item) => item.directory)).toContain("/repo/local-feature")
  })


  test("cloud main selection does not submit to local main when no cloud workspace is selected", async () => {
    state.demoMode = false
    const startup: Array<{ status?: string; id?: string; err?: string }> = []

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
      newSessionWorktree: () => "main",
      newSessionWorkspaceKind: () => "cloud",
      onCloudStartup: (state) => {
        startup.push({ status: state?.status, id: state?.id, err: state?.err })
      },
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    const createCall = apiCalls.find((item) => new URL(item.url).pathname === "/api/workspace/create")
    expect(createCall?.method).toBe("POST")
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ projectId: "project-1" })
    expect(optimisticAdds.map((item) => item.directory)).toContain("ws_1")
    expect(optimisticAdds.map((item) => item.directory)).not.toContain("/repo/main")
    expect(startup.some((item) => item.status === "acquiring_sandbox" && item.id === "ws_1")).toBe(true)
  })


  test("cloud existing-workspace selection reuses that cloud directory instead of creating another one", async () => {
    state.demoMode = false
    state.syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["workspace:ws_cloud"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "workspace:ws_cloud": { kind: "cloud", workspace_name: "feature-cloud" },
      },
    }
    state.globalProjects = [state.syncProject]
    seedProjectCatalog()

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "workspace:ws_cloud",
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
      newSessionWorktree: () => "workspace:ws_cloud",
      newSessionWorkspaceKind: () => "cloud",
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(optimisticAdds.map((item) => item.directory)).toContain("workspace:ws_cloud")
  })


  test("reuses the active new-session tab when the first prompt creates a real session", async () => {
    state.demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []

    state.mockClaxedoState = {
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

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([])
    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(handoffCalls).toEqual([{ sessionKey: "workspace:%2Frepo%2Fmain:session:session-1", sessionID: "session-1" }])
    expect(navCalls).toHaveLength(1)
    expect(navCalls).toEqual(["/w/%2Frepo%2Fmain/session/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", harnessType: "opencode" }])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
  })


  test("navigates and refreshes when a workbench-scoped new session creates a real session", async () => {
    state.demoMode = false
    state.mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "pane-1",
      surfaceId: () => "tab-new",
      leafId: () => "tab-new",
    }

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const showCalls: string[] = []

    state.mockClaxedoState = {
      wb: {
        state: { panes: [{ id: "pane-1" }] },
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
        openSession: () => "tab-added",
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

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([])
    expect(showCalls).toEqual(["tab-added"])
    expect(navCalls).toHaveLength(1)
    expect(navCalls).toEqual(["/w/%2Frepo%2Fmain/session/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", harnessType: "opencode" }])
  })


  test("draft-backed create leaves Workbench surface handoff to lifecycle events", async () => {
    state.demoMode = false

    const closeCalls: string[] = []
    const openCalls: Array<{ directory: string; sessionID: string; title: string }> = []
    const showCalls: string[] = []

    state.mockClaxedoState = {
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

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "Session" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(closeCalls).toEqual([])
    expect(navCalls).toEqual(["/w/%2Frepo%2Fmain/session/session-1"])
  })


  test("split-mode handoff still patches the draft tab even if focus shifts before the microtask", async () => {
    state.demoMode = false

    const patchCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
    state.mockSessionParams = {
      sessionId: () => "new",
      directory: () => "/repo/main",
      paneId: () => "group-1",
      surfaceId: () => "tab-new",
      leafId: () => "leaf-1",
    }

    state.mockClaxedoState = {
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
      layout: {},
    }
    state.harnessMode = true

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
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

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(patchCalls).toEqual([
      {
        id: "tab-new",
        patch: {
          directory: "/repo/main",
          sessionId: "session-1",
          content: {
            type: "session",
            directory: "/repo/main",
            sessionId: "session-1",
            title: "Session",
            sessionRef: {
              sessionId: "session-1",
              host: "workspace",
              harness: { id: "claude-acp" },
              cwd: "/repo/main",
              toolSandbox: { kind: "local", cwd: "/repo/main" },
            },
          },
        },
      },
    ])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
    expect(sessionStatusFor("/repo/main", "session-1")).toEqual({ type: "busy" })
  })
})
