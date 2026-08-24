import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import * as h from "./submit.harness.test"

const {
  createSubmit,
  createPromptSubmit,
  submitEvent,
  settleSubmitEffects,
  waitForSubmitEffect,
  seedProjectCatalog,
  seedCommandList,
  sessionStatusFor,
  localSessionRef,
  promptLengthForTest,
  repoMainPromptScope,
  promptValue,
  state,
  calls,
  boots,
  apiCalls,
  fetchCalls,
  unsignedCalls,
  runtimeCalls,
  transportPromptAsyncCalls,
  sessionCreateCalls,
  transportClients,
  harnessSetCalls,
  buildRequestPartCalls,
  shellCalls,
  commandCalls,
  navCalls,
  flowEvents,
  handoffCalls,
  toasts,
  promptCalls,
  optimisticAdds,
  optimisticRemoves,
  promptContextItems,
  promptContextAdds,
  promptContextRemoves,
  refreshCalls,
  bootstrapCalls,
  worktreeCreateCalls,
  enabledAutoAccept,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("Workspace-runtime transport + model resolution", () => {
  test("loopback cloud workspace refs use workspace runtime transport for create and prompt", async () => {
    state.demoMode = false
    state.harnessMode = false

    const cloudDir = "ws_123"
    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => cloudDir,
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

    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(harnessSetCalls).toEqual([])
    expect(transportClients.length).toBeGreaterThanOrEqual(2)
    expect(transportClients.every((item) => item.directory === cloudDir)).toBe(true)
    expect(refreshCalls).toEqual([{ directory: cloudDir, harnessType: "opencode" }])
  })

  test("non-harness submit treats the signed-workspace placeholder as no model", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = undefined
    state.localCurrentAgent = undefined
    state.localAgentList = [{ name: "build" }, { name: "plan" }]

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "ws_local_image_codex",
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
      fallbackModel: () => ({ id: "big-pickle", provider: { id: "opencode" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(runtimeCalls.some((call) => call.input.startsWith("/session/"))).toBe(false)
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })

  test("existing workspace sessions do not fall back to unrelated provider defaults while selection restores", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = undefined
    state.localCurrentAgent = { name: "build" }
    state.runtimeSessionConfig = { harness: { id: "opencode", access: "native" }, agent: "build" }
    state.runtimeProviderResponse = {
      all: {
        google: {
          id: "google",
          models: {
            "nano-banana-pro": { name: "Nano Banana Pro" },
          },
        },
      },
      connected: ["google"],
      default: { google: "nano-banana-pro" },
    }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "ws_local_image_codex",
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
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      fallbackModel: () => ({ id: "nano-banana-pro", provider: { id: "google" } }),
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(runtimeCalls.some((call) => call.input.startsWith("/provider"))).toBe(false)
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })

  test("loopback resumed workspace sessions keep directory on prompt_async", async () => {
    state.demoMode = false
    state.harnessMode = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "workspace:ws_resumed",
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
    expect(calls.transportAsync).toBe(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-existing",
      directory: "workspace:ws_resumed",
    })
  })

  test("signed control-plane existing normal submit reuses canonical config on runtime transport", async () => {
    state.demoMode = false
    state.runtimeSessionConfig = {
      harness: { id: "opencode", access: "native" },
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
    }

    const submit = createSubmit({
      info: () => ({ id: "signed-existing" }),
      sessionID: () => "signed-existing",
      sessionDirectory: () => "/repo/main",
      signedControlPlane: () => true,
      composerMode: () => ({ kind: "session", ref: localSessionRef("signed-existing") }),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ sessionID: "signed-existing" })
    expect(runtimeCalls).toContainEqual(
      expect.objectContaining({
        input: "/session/signed-existing/config?directory=%2Frepo%2Fmain&harness=opencode",
        method: "GET",
      }),
    )
    expect(runtimeCalls.some((call) => call.method === "PATCH")).toBe(false)
    expect(toasts).toEqual([])
  })
})
