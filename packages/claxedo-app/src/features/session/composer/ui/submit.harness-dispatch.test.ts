import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import type { Prompt } from "@/features/session/providers/prompt"
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

describe("Harness + demo dispatch and abort", () => {
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

    await submit.handleSubmit(submitEvent())
    await waitForSubmitEffect(() =>
      calls.prompt === 1 || runtimeCalls.some((call) => call.input.includes("/message"))
    )

    expect(calls.prompt + runtimeCalls.filter((call) => call.input.includes("/message")).length).toBe(1)
    expect(calls.async).toBe(0)
  })


  test("harness draft submit reuses the prewarmed session instead of creating one on send", async () => {
    state.demoMode = false
    state.harnessMode = true
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

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(boots).toEqual([
      { phase: "booting", harness: "Claude", sessionID: undefined },
      { phase: "booting", harness: "Claude", sessionID: "session-1" },
      { phase: "sending", harness: "Claude", sessionID: "session-1" },
      undefined,
    ])
    expect(apiCalls).toHaveLength(0)
    expect(unsignedCalls).toHaveLength(1)
    expect(unsignedCalls[0]?.url).toBe("http://localhost:3001/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp")
    expect(unsignedCalls[0]?.method).toBe("PATCH")
    expect(unsignedCalls[0]?.authorization).toBeNull()
    expect(transportClients).toHaveLength(1)
    expect(transportClients[0]?.baseUrl).toBe("http://localhost:3001")
    expect(transportClients[0]?.directory).toBe("/repo/main")
    expect(transportClients[0]?.fetch).not.toBeUndefined()
    expect(JSON.parse(unsignedCalls[0]?.body ?? "{}")).toEqual({
      harness: { type: "claude-acp" },
      agent: "agent",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
  })


  test("harness submit uses the harness-selected model instead of stale local provider state", async () => {
    state.demoMode = false
    state.harnessMode = true
    state.localCurrentModel = { id: "stale-provider-model", provider: { id: "anthropic" } }
    state.harnessSubmitModel = { key: { providerID: "codex-acp", modelID: "gpt-5.5" }, name: "GPT-5.5" }

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    })
  })


  test("harness submit does not leak the OpenCode reasoning variant", async () => {
    state.demoMode = false
    state.harnessMode = true

    const submit = createSubmit({
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).not.toHaveProperty("variant")
    expect(JSON.parse(unsignedCalls.at(-1)?.body ?? "{}")).not.toHaveProperty("variant")
  })


  test("existing harness follow-up drops a stale persisted OpenCode variant", async () => {
    state.demoMode = false

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { type: "claude-acp" },
          agent: "build",
          model: { providerID: "claude-acp", modelID: "opus" },
          variant: "high",
        },
      }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "/repo/main",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
    expect(transportPromptAsyncCalls.at(-1)).not.toHaveProperty("variant")
    expect(JSON.parse(unsignedCalls.at(-1)?.body ?? "{}")).toEqual({
      harness: { type: "claude-acp" },
      agent: "build",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
  })


  test("harness draft submit refuses unresolved provider/model state", async () => {
    state.demoMode = false
    state.harnessMode = true
    state.harnessSubmitModel = undefined
    const submit = createSubmit({
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(optimisticAdds).toEqual([])
    expect(boots).toEqual([])
    expect(toasts).toContainEqual({
      title: "prompt.toast.modelAgentRequired.title",
      description: "prompt.toast.modelAgentRequired.description",
    })
  })


  test("stale harness boot callbacks do not update a newer composer scope", async () => {
    state.demoMode = false
    state.harnessMode = true
    let resolveClaim: (session: { id: string }) => void = () => undefined
    let scope = "old"
    state.harnessClaimSession = new Promise((resolve) => {
      resolveClaim = resolve
    })
    const submit = createSubmit({
      bootScope: () => scope,
      setBooting: (value) => boots.push(value),
    })

    const pending = submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    scope = "new"
    resolveClaim({ id: "session-1" })
    await pending
    await settleSubmitEffects()

    expect(boots).toEqual([{ phase: "booting", harness: "Claude", sessionID: undefined }])
    expect(calls.transportAsync).toBe(1)
  })


  test("harness claim failure does not fall back to OpenCode create", async () => {
    state.demoMode = false
    state.harnessMode = true
    state.harnessClaimSession = undefined
    const submit = createSubmit({
      setBooting: (value) => boots.push(value),
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(optimisticAdds).toEqual([])
    expect(boots).toEqual([{ phase: "booting", harness: "Claude", sessionID: undefined }, undefined])
    expect(toasts).toEqual([])
  })


  test("signed harness draft submit uses Workspace Runtime transport instead of old session compatibility", async () => {
    state.demoMode = false
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
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(calls.async).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(boots).toEqual([])
    expect(apiCalls.some((item) => new URL(item.url).pathname.startsWith("/session/"))).toBe(false)
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp",
      method: "PATCH",
    }))
    expect(toasts).toEqual([])
  })


  test("signed harness submit ignores stale shell mode and sends a chat prompt", async () => {
    state.demoMode = false
    state.harnessMode = true

    const modes: Array<"normal" | "shell"> = []
    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "new",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: (mode) => {
        modes.push(mode)
      },
      setPopover: () => undefined,
      onSubmit: () => undefined,
      navigateOnCreate: () => false,
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.shell).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(modes).toContain("normal")
    expect(runtimeCalls).toContainEqual(expect.objectContaining({
      input: "/session/session-1/config?directory=%2Frepo%2Fmain&harness=claude-acp",
      method: "PATCH",
    }))
  })


  test("signed harness existing session sends even when runtime get cannot hydrate the session", async () => {
    state.demoMode = false
    state.harnessMode = true
    state.transportGetSession = false

    const submit = createPromptSubmit({
      info: () => undefined,
      sessionID: () => "existing-session",
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
      signedControlPlane: () => true,
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(1)
    expect(toasts).toEqual([])
  })


  test("signed control-plane abort reaches the workspace runtime transport", async () => {
    state.demoMode = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      surfaceId: () => "tab-new",
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      signedControlPlane: () => true,
    })

    await submit.abort()

    expect(calls.transportAbort).toBe(1)
    expect(transportClients).toHaveLength(1)
    expect(transportClients[0]?.baseUrl).toBe("http://localhost:3001")
    expect(transportClients[0]?.directory).toBe("/repo/main")
    expect(sessionStatusFor("/repo/main", "session-1")).toEqual({ type: "idle" })
    const testQueryClient = (await import("@/platform/query/query-client")).queryClient
    const shellDataKeys = (await import("@/platform/sync/keys")).shellDataKeys
    expect(testQueryClient.getQueryData(shellDataKeys.sessionId("session-1", "requests"))).toEqual({
      permissions: [],
      questions: [],
    })
  })


  test("empty active submit aborts without history or send side effects", async () => {
    state.demoMode = false
    promptValue.splice(0, promptValue.length, { type: "text", content: "   ", start: 0, end: 3 })
    const histories: Prompt[] = []

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      working: () => true,
      signedControlPlane: () => true,
      addToHistory: (prompt) => {
        histories.push(prompt)
      },
    })

    await submit.handleSubmit(submitEvent())

    expect(calls.transportAbort).toBe(1)
    expect(calls.create).toBe(0)
    expect(calls.transportAsync).toBe(0)
    expect(histories).toEqual([])
  })

})
