import { describe, expect, test } from "bun:test"
import { createPageEditorAiActions, type PageEditorAiDeps } from "./page-editor-ai"
import type { AiRequest } from "./page-editor-model"
import type { OverlayEvent, OverlayState, AiSelection } from "./page-editor-utils"

// The page-editor AI action factory owns session-on-demand creation and the
// AI request lifecycle (error surfacing, run-invalidation, overlay results).
// It takes every dependency as an injected getter/setter, so these specs drive
// the real factory with in-memory fakes — no editor mount, no network.

type PromptResponse = {
  data?: { info?: { error?: { type?: string; message?: string } }; parts?: Array<{ type?: string; text?: string }> }
  error?: { message?: string }
}

function makeHarness(over: {
  pageSdk?: PageEditorAiDeps["pageSdk"]
  claxedoState?: PageEditorAiDeps["claxedoState"]
  peerSessionId?: string
  savedSessionId?: string
  aiBusy?: boolean
} = {}) {
  const state = {
    aiBusy: over.aiBusy ?? false,
    aiError: undefined as string | undefined,
    aiLastRequest: null as AiRequest | null,
    savedSessionId: over.savedSessionId as string | undefined,
    overlayEvents: [] as OverlayEvent[],
  }
  const calls = { saveSessionId: [] as string[], overlayStates: [] as OverlayState[] }

  const noop = () => {}
  const deps: PageEditorAiDeps = {
    editor: () => undefined,
    pageSdk: over.pageSdk,
    claxedoState: over.claxedoState,
    peerSessionId: () => over.peerSessionId,
    savedSessionId: () => state.savedSessionId,
    saveSessionId: (id) => {
      state.savedSessionId = id
      calls.saveSessionId.push(id)
    },
    directory: () => "/repo",
    surfaceId: () => undefined,
    aiBusy: () => state.aiBusy,
    setAiBusy: (v) => (state.aiBusy = v),
    setAiError: (v) => (state.aiError = v),
    aiLastRequest: () => state.aiLastRequest,
    setAiLastRequest: (v) => (state.aiLastRequest = v),
    aiAnchor: () => null,
    setAiAnchor: noop,
    aiSelection: () => null,
    setAiSelection: noop,
    customAiValue: () => "",
    setCustomAiValue: noop,
    overlayEvent: (event) => state.overlayEvents.push(event),
    setOverlayState: (s) => calls.overlayStates.push(s),
    aiPreview: () => null,
    aiMenuOpen: () => false,
    getSelection: () => null,
    hasActiveSelection: () => false,
    hasAiSelection: () => false,
    clampRange: (r) => r,
    replaceRange: () => null,
    clearDiffMarks: noop,
    computePreviewPos: () => ({ x: 0, y: 0, placement: "below" }) as never,
    computeToolbarPos: () => null,
    computeAnchorPos: () => null,
    toolbarPos: () => null,
    openAiMenuPos: () => null,
    scheduleToolbar: noop,
    clearToolbarTimer: noop,
    bumpTick: noop,
    setMoreMenuOpen: noop,
    setTableMenuOpen: noop,
    setLinkMenuOpen: noop,
    customAiInput: () => undefined,
  }
  return { deps, state, calls }
}

function fakeSdk(opts: {
  onPrompt?: (actions: ReturnType<typeof createPageEditorAiActions>) => void
  promptResponse?: PromptResponse
  getResponse?: { data?: unknown } | null
  createResponse?: { data?: { id?: string } }
}) {
  const record = { prompt: [] as unknown[], created: [] as unknown[], got: [] as unknown[] }
  let actionsRef: ReturnType<typeof createPageEditorAiActions>
  const sdk = {
    client: {
      session: {
        get: async (input: unknown) => {
          record.got.push(input)
          return opts.getResponse ?? null
        },
        create: async (input: unknown) => {
          record.created.push(input)
          return opts.createResponse ?? { data: { id: "session-new" } }
        },
        prompt: async (input: unknown) => {
          record.prompt.push(input)
          opts.onPrompt?.(actionsRef)
          return opts.promptResponse ?? { data: { parts: [{ type: "text", text: "AI output" }] } }
        },
      },
    },
    // as-any: partial SDK double — only session.get/create/prompt are exercised here.
  } as unknown as PageEditorAiDeps["pageSdk"]
  return { sdk, record, bind: (a: ReturnType<typeof createPageEditorAiActions>) => (actionsRef = a) }
}

const request = (over: Partial<AiRequest> = {}): AiRequest => ({
  action: "custom",
  instruction: "make it better",
  selection: null,
  text: "",
  context: "the whole document",
  panel: { x: 0, y: 0, placement: "below" } as never,
  ...over,
})

describe("executeAiRequest", () => {
  test("with no session SDK, surfaces the 'open a session' error and does not go busy", async () => {
    const { deps, state } = makeHarness({ pageSdk: undefined })
    const actions = createPageEditorAiActions(deps)
    await actions.executeAiRequest(request())
    expect(state.aiError).toBe("No active session — open a session in the side pane first.")
    expect(state.aiBusy).toBe(false)
  })

  test("returns immediately (no error) when already busy", async () => {
    const { deps, state } = makeHarness({ pageSdk: {} as never, aiBusy: true })
    const actions = createPageEditorAiActions(deps)
    await actions.executeAiRequest(request())
    expect(state.aiError).toBeUndefined()
    expect(state.overlayEvents).toEqual([])
  })

  test("with a peer session but empty model output, surfaces the empty-output error", async () => {
    const f = fakeSdk({ promptResponse: { data: { parts: [{ type: "text", text: "   " }] } } })
    const { deps, state } = makeHarness({ pageSdk: f.sdk, peerSessionId: "s1" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    await actions.executeAiRequest(request())
    expect(state.aiError).toBe("AI returned empty output")
    expect(state.aiBusy).toBe(false)
  })

  test("surfaces a model-side info.error message", async () => {
    const f = fakeSdk({ promptResponse: { data: { info: { error: { message: "rate limited" } } } } })
    const { deps, state } = makeHarness({ pageSdk: f.sdk, peerSessionId: "s1" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    await actions.executeAiRequest(request())
    expect(state.aiError).toBe("rate limited")
  })

  test("on success for a non-selection request, emits an AI_RESULT overlay with the model output and clears busy", async () => {
    const f = fakeSdk({ promptResponse: { data: { parts: [{ type: "text", text: "polished text" }] } } })
    const { deps, state } = makeHarness({ pageSdk: f.sdk, peerSessionId: "s1" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    await actions.executeAiRequest(request())
    const result = state.overlayEvents.find((e) => e.type === "AI_RESULT")
    expect(result).toBeDefined()
    expect((result as Extract<OverlayEvent, { type: "AI_RESULT" }>).draft).toMatchObject({
      text: "polished text",
      inline: false,
    })
    expect(state.aiError).toBeUndefined()
    expect(state.aiBusy).toBe(false)
    expect(state.aiLastRequest).not.toBeNull()
  })

  test("when a newer run is started mid-flight, discards the stale result and leaves busy owned by the new run", async () => {
    const f = fakeSdk({
      onPrompt: (actions) => actions.invalidateRuns(), // a newer run supersedes this one
      promptResponse: { data: { parts: [{ type: "text", text: "stale output" }] } },
    })
    const { deps, state } = makeHarness({ pageSdk: f.sdk, peerSessionId: "s1" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    await actions.executeAiRequest(request())
    expect(state.overlayEvents.some((e) => e.type === "AI_RESULT")).toBe(false)
    expect(state.aiError).toBeUndefined()
    // The invalidating (newer) run owns the busy flag; the stale run must not clear it.
    expect(state.aiBusy).toBe(true)
  })
})

describe("ensurePeerSession", () => {
  test("creates a new session (scoped to the directory) when none is stored", async () => {
    const f = fakeSdk({ createResponse: { data: { id: "session-created" } } })
    const { deps, state, calls } = makeHarness({ pageSdk: f.sdk, claxedoState: {} as never })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    const id = await actions.ensurePeerSession()
    expect(id).toBe("session-created")
    expect(f.record.created).toEqual([{ directory: "/repo" }])
    expect(calls.saveSessionId).toEqual(["session-created"])
    expect(state.savedSessionId).toBe("session-created")
  })

  test("reuses a stored session id when the server still has it, without creating a new one", async () => {
    const f = fakeSdk({ getResponse: { data: { id: "session-old" } } })
    const { deps, calls } = makeHarness({ pageSdk: f.sdk, claxedoState: {} as never, savedSessionId: "session-old" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    const id = await actions.ensurePeerSession()
    expect(id).toBe("session-old")
    expect(f.record.created).toEqual([]) // never created a fresh one
    expect(calls.saveSessionId).toEqual(["session-old"])
  })

  test("falls back to creating when the stored session id is gone from the server", async () => {
    const f = fakeSdk({ getResponse: null, createResponse: { data: { id: "session-fresh" } } })
    const { deps } = makeHarness({ pageSdk: f.sdk, claxedoState: {} as never, savedSessionId: "session-dead" })
    const actions = createPageEditorAiActions(deps)
    f.bind(actions)
    const id = await actions.ensurePeerSession()
    expect(id).toBe("session-fresh")
    expect(f.record.created).toHaveLength(1)
  })

  test("returns undefined when there is no SDK", async () => {
    const { deps } = makeHarness({ pageSdk: undefined })
    const actions = createPageEditorAiActions(deps)
    expect(await actions.ensurePeerSession()).toBeUndefined()
  })
})
