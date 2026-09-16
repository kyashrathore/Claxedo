import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { promptScopeKey } from "./submit-prompt-scope"
import * as h from "./test-support/submit-harness"

const {
  createSubmit,
  createPromptSubmit,
  submitEvent,
  settleSubmitEffects,
  waitForSubmitEffect,
  seedProjectCatalog,
  sessionStatusFor,
  promptLengthForTest,
  promptValue,
  state,
  calls,
  apiCalls,
  fetchCalls,
  runtimeCalls,
  transportPromptAsyncCalls,
  sessionCreateCalls,
  navCalls,
  flowEvents,
  handoffCalls,
  toasts,
  sessionPromotionCalls,
  harnessClaimCalls,
  promptCalls,
  optimisticAdds,
  optimisticRemoves,
  promptContextItems,
  promptContextAdds,
  promptContextRemoves,
  refreshCalls,
  bootstrapCalls,
  worktreeCreateCalls,
  hostedOperationCalls,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("New-session creation: cloud, worktree, and tab handoff", () => {
  test("clears the visible workspace draft after creating a new session", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    const stateAtSubmit: Array<{ resetCount: number; optimisticCount: number }> = []
    const historyWrites: Array<{ mode: string; scope: unknown; resets: number }> = []

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
      addToHistory: (_prompt, mode, scope) => {
        historyWrites.push({ mode, scope, resets: promptCalls.reset.length })
      },
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => {
        stateAtSubmit.push({
          resetCount: promptCalls.reset.length,
          optimisticCount: optimisticAdds.length,
        })
      },
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    // clearInput resets RAW {dir, id, draftId} scopes — `pick`/`promptScopeKey` applies
    // `sessionViewKey` exactly once, resolving each to the same persist key the
    // composer reads (the draft slot before creation, the session slot after).
    // Pre-computing the key inside the scope would double-wrap it and leave the
    // just-sent text in the composer.
    expect(promptCalls.reset).toEqual([
      { dir: "/repo/main", id: "new", draftId: "draft-1" },
      { dir: "/repo/main", id: "session-1" },
    ])
    expect(promptCalls.reset.map((scope) => promptScopeKey(scope))).toEqual([
      "draft:draft-1",
      "workspace:%2Frepo%2Fmain:session:session-1",
    ])
    expect(sessionCreateCalls).toEqual([])
    expect(harnessClaimCalls).toContainEqual({
      directory: "/repo/main",
      sessionId: "new",
      headers: { "x-claxedo-draft-id": "draft-1" },
      harness: { kind: "native", harnessId: "pi" },
      sessionConfig: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: undefined,
      },
    })
    expect(sessionPromotionCalls).toEqual([{ sessionID: "session-1", configWrites: 0 }])
    expect(stateAtSubmit).toEqual([{ resetCount: 2, optimisticCount: 1 }])
    // The send is recorded once, into the created session's recall stack — not
    // the draft surface's — and before the drafts are reset.
    expect(historyWrites).toEqual([{ mode: "normal", scope: { dir: "/repo/main", id: "session-1" }, resets: 0 }])
  })

  test("unattached drafts refuse to create a session from the sdk directory fallback", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

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

  test("does not publish or prompt when the canonical session claim fails", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.sessionConfigSaveError = "config unavailable"

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
      promptLength: promptLengthForTest,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(harnessClaimCalls).toHaveLength(1)
    expect(sessionCreateCalls).toEqual([])
    expect(sessionPromotionCalls).toEqual([])
    expect(optimisticAdds).toEqual([])
    expect(calls.prompt + calls.async + calls.transportAsync).toBe(0)
    expect(toasts).toContainEqual({
      title: "prompt.toast.sessionCreateFailed.title",
      description: "config unavailable",
    })
  })

  test("cloud new button creates a cloud workspace before the first prompt and reports startup", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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
      newSessionBaseRef: () => "origin/release/next",
      newSessionSourceBranch: () => "release/next",
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

    expect(hostedOperationCalls).toContainEqual({
      operation: "workspace.create",
      input: { projectId: "project-1", gitBranch: "release/next" },
    })
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(bootstrapCalls).toEqual(["bootstrap"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/claxedo/workspace/resolve")
    expect(fetchCalls.map((item) => new URL(item.url).pathname)).toContain("/api/workspace/ws_1/connection")
    // Runtime preparation progress is remembered but not shown as a second
    // submit overlay; WorkspaceGate owns those connection phases.
    expect(startup.some((item) => item.status === "loading_models")).toBe(true)
    expect(startup.some((item) => item.status === "creating_session")).toBe(true)
    expect(startup.some((item) => item.status === "sending_prompt")).toBe(true)
    expect(startup.at(-1)).toEqual({ status: undefined, id: undefined, err: undefined })
    expect(resetCalls).toBe(0)
  })

  test("a cloud draft without a harness cannot provision using stale provider state", async () => {
    const submit = createSubmit({
      sessionID: () => "new",
      newSessionWorktree: () => "create",
      newSessionWorkspaceKind: () => "cloud",
      harnessController: { ...h.testHarnessController(), harness: () => undefined },
    })
    await submit.handleSubmit(submitEvent())
    expect(hostedOperationCalls).toEqual([])
    expect(apiCalls.some((call) => call.url.includes("/api/workspace/create"))).toBe(false)
    expect(harnessClaimCalls).toEqual([])
    expect(calls.transportAsync).toBe(0)
    expect(toasts).toContainEqual({ title: "prompt.toast.modelAgentRequired.title", description: "prompt.toast.modelAgentRequired.description" })
  })

  test("cloud create preserves selected model instead of replacing it with runtime fallback", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.localCurrentModel = { id: "gpt-5.5-pro", provider: { id: "openai" } }
    state.piSubmitModel = { key: { providerID: "openai", modelID: "gpt-5.5-pro" }, name: "GPT-5.5 Pro" }
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

    expect(harnessClaimCalls.at(-1)).toMatchObject({
      directory: "ws_1",
      sessionConfig: {
        model: { providerID: "openai", modelID: "gpt-5.5-pro" },
      },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-5.5-pro" },
    })
  })

  // Submit takes only the harness controller's explicit model key; it never
  // substitutes a provider default. The cloud-create path is the last one
  // that could still reach a runtime `/provider` catalog, so it keeps its
  // own gate against that fallback.
  test("cloud create fails loud instead of resolving a model from workspace runtime providers", async () => {
    state.piSubmitModel = undefined
    state.runtimeSessionUrl = "http://runtime.example.com"
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

    expect(runtimeCalls.some((call) => call.input.startsWith("/provider?"))).toBe(false)
    expect(sessionCreateCalls).toEqual([])
    expect(calls.create).toBe(0)
    expect(transportPromptAsyncCalls).toEqual([])
    // The model gate must reject BEFORE directory provisioning: a cloud
    // workspace created for a submit that then fails the gate is orphaned —
    // nothing ever adopts or deletes it.
    expect(hostedOperationCalls).toEqual([])
    expect(apiCalls.some((call) => new URL(call.url).pathname === "/api/workspace/create")).toBe(false)
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })

  test("cloud create retargets the active new-session tab to the created workspace", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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
    expect(openCalls).toEqual([{ directory: "ws_1", sessionID: "session-1", title: "hello" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toContainEqual({
      directory: "ws_1",
      sessionID: "session-1",
    })
    expect(startup.some((item) => item.status === "opening_session")).toBe(true)
    expect(flowEvents.indexOf("optimistic:session-1")).toBeLessThan(flowEvents.indexOf("navigate:/w/ws_1/session/session-1"))
  })

  test("cloud startup stays open with the relay error when the first prompt fails", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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
    state.runtimeSessionUrl = "http://runtime.example.com"
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

    expect(hostedOperationCalls).toContainEqual({
      operation: "workspace.create",
      input: { projectId: "project-formlink" },
    })
    expect(toasts.find((toast) => toast.title === "Failed to create cloud workspace")).toBeUndefined()
  })

  test("local create selection creates a worktree before the first prompt", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

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
      newSessionBaseRef: () => "feature/base-ref",
      newSessionWorkspaceKind: () => "local",
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(worktreeCreateCalls).toEqual([{
      directory: "/repo/main",
      worktreeCreateInput: { baseRef: "feature/base-ref" },
    }])
    expect(hostedOperationCalls).toEqual([])
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
    state.runtimeSessionUrl = "http://runtime.example.com"
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

    expect(hostedOperationCalls).toEqual([])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(worktreeCreateCalls).toEqual([])
    expect(optimisticAdds.map((item) => item.directory)).toContain("/repo/local-feature")
  })

  test("cloud main selection does not submit to local main when no cloud workspace is selected", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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

    expect(hostedOperationCalls).toContainEqual({
      operation: "workspace.create",
      input: { projectId: "project-1" },
    })
    expect(optimisticAdds.map((item) => item.directory)).toContain("ws_1")
    expect(optimisticAdds.map((item) => item.directory)).not.toContain("/repo/main")
  })

  test("cloud existing-workspace selection reuses that cloud directory instead of creating another one", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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

    expect(hostedOperationCalls).toEqual([])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(optimisticAdds.map((item) => item.directory)).toContain("workspace:ws_cloud")
  })

  test("reuses the active new-session tab when the first prompt creates a real session", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

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
    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "hello" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(handoffCalls).toEqual([{ sessionKey: "workspace:%2Frepo%2Fmain:session:session-1", sessionID: "session-1" }])
    expect(navCalls).toHaveLength(1)
    expect(navCalls).toEqual(["/w/project-1/session/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", harnessType: "pi" }])
    expect(optimisticAdds.map((item) => ({ directory: item.directory, sessionID: item.sessionID }))).toEqual([
      { directory: "/repo/main", sessionID: "session-1" },
    ])
  })

  test("navigates and refreshes when a workbench-scoped new session creates a real session", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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
    expect(navCalls).toEqual(["/w/project-1/session/session-1"])
    expect(refreshCalls).toEqual([{ directory: "/repo/main", harnessType: "pi" }])
  })

  test("draft-backed create leaves Workbench surface handoff to lifecycle events", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

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

    expect(openCalls).toEqual([{ directory: "/repo/main", sessionID: "session-1", title: "hello" }])
    expect(showCalls).toEqual(["tab-added"])
    expect(closeCalls).toEqual([])
    expect(navCalls).toEqual(["/w/project-1/session/session-1"])
  })

  test("split-mode handoff patches the explicitly targeted draft tab", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

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
            title: "hello",
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
            title: "hello",
            sessionRef: {
              sessionId: "session-1",
              host: "workspace",
              harness: { kind: "native", harnessId: "claude" },
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
