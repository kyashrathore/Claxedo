import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as h from "./test-support/submit-harness"

const {
  createSubmit,
  createPromptSubmit,
  submitEvent,
  settleSubmitEffects,
  waitForSubmitEffect,
  localSessionRef,
  promptLengthForTest,
  state,
  calls,
  runtimeCalls,
  transportPromptAsyncCalls,
  transportClients,
  harnessSetCalls,
  toasts,
  refreshCalls,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("Workspace-runtime transport + model resolution", () => {
  test("loopback provisioner-placed workspace refs use workspace runtime transport for create and prompt", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
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
    expect(transportClients).toHaveLength(1)
    expect(transportClients.every((item) => item.directory === cloudDir)).toBe(true)
    expect(runtimeCalls.filter((call) => call.input.includes("/prompt_async") && call.method === "POST")).toHaveLength(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ sessionID: "session-1", directory: cloudDir })
    expect(refreshCalls).toEqual([{ directory: cloudDir, harnessType: "pi" }])
  })

  test("a draft without an authoritative model key cannot submit", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = false
    state.localCurrentModel = undefined
    state.piSubmitModel = undefined
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
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = false
    state.localCurrentModel = undefined
    state.localCurrentAgent = { name: "build" }
    state.runtimeSessionConfig = { harness: { id: "pi", access: "native" }, agent: "build" }
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
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(runtimeCalls.some((call) => call.input.startsWith("/provider"))).toBe(false)
    expect(toasts).toContainEqual({
      title: "prompt.toast.promptSendFailed.title",
      description: "The session configuration is not available yet. Try again after it loads.",
      variant: "error",
    })
  })

  test("loopback resumed workspace sessions keep directory on prompt_async", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "ws_resumed",
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
      directory: "ws_resumed",
    })
  })

  test("signed control-plane existing normal submit reuses canonical config on runtime transport", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.runtimeSessionConfig = {
      harness: { id: "pi", access: "native" },
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
    }

    const submit = createSubmit({
      info: () => ({ id: "signed-existing" }),
      sessionID: () => "signed-existing",
      sessionDirectory: () => "/repo/main",
      conversationDirectory: () => "/mounted/conversation",
      signedControlPlane: () => true,
      composerMode: () => ({ kind: "session", ref: localSessionRef("signed-existing") }),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ sessionID: "signed-existing", directory: "/repo/main" })
    expect(h.optimisticAdds).toContainEqual(expect.objectContaining({ sessionID: "signed-existing", directory: "/mounted/conversation" }))
    expect(h.buildRequestPartCalls.at(-1)).toMatchObject({ sessionDirectory: "/repo/main" })
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/signed-existing/config?directory=%2Frepo%2Fmain",
      method: "GET",
    }))
    expect(runtimeCalls.some((call) => call.method === "PATCH")).toBe(false)
    expect(toasts).toEqual([])
  })

})
