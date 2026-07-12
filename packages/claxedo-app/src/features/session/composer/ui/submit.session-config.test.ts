import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
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

describe("Existing-session config persistence (rubric C1 dedupe)", () => {
  test("existing sessions persist submitted model and agent config", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = { id: "new-model", provider: { id: "new-provider" } }
    state.localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-existing" }),
      sessionID: () => "session-existing",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(calls.create).toBe(0)
    expect(unsignedCalls).toContainEqual(expect.objectContaining({
      url: "http://localhost:3001/session/session-existing/config?directory=%2Frepo%2Fmain&harness=opencode",
      method: "PATCH",
      authorization: null,
    }))
    expect(JSON.parse(unsignedCalls.find((call) =>
      call.url === "http://localhost:3001/session/session-existing/config?directory=%2Frepo%2Fmain&harness=opencode"
    )?.body ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "review",
      model: { providerID: "new-provider", modelID: "new-model" },
    })
    expect(JSON.parse(queryClient.getQueryData<string>(h.savedSessionConfigQueryKey("session-existing")) ?? "{}")).toEqual({
      harness: { type: "opencode" },
      agent: "review",
      model: { providerID: "new-provider", modelID: "new-model" },
    })
  })


  test("rubric C1: second submit with unchanged config does NOT re-PATCH", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = { id: "new-model", provider: { id: "new-provider" } }
    state.localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-c1-dedup" }),
      sessionID: () => "session-c1-dedup",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const configUrl = "http://localhost:3001/session/session-c1-dedup/config?directory=%2Frepo%2Fmain&harness=opencode"
    const firstCount = unsignedCalls.filter((call) => call.url === configUrl).length
    expect(firstCount).toBe(1)

    // Submit again with the same model/agent — no PATCH should fire.
    promptValue.splice(0, promptValue.length, { type: "text", content: "another", start: 0, end: 7 })
    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const secondCount = unsignedCalls.filter((call) => call.url === configUrl).length
    expect(secondCount).toBe(1) // still 1 — dedup blocked the second PATCH
  })


  test("rubric C1: changed model triggers a fresh PATCH after the dedup hit", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = { id: "model-a", provider: { id: "prov" } }
    state.localCurrentAgent = { name: "review" }

    const submit = createSubmit({
      info: () => ({ id: "session-c1-change" }),
      sessionID: () => "session-c1-change",
      sessionDirectory: () => "/repo/main",
      agent: () => "review",
      navigateOnCreate: () => false,
    })

    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const configUrl = "http://localhost:3001/session/session-c1-change/config?directory=%2Frepo%2Fmain&harness=opencode"
    expect(unsignedCalls.filter((call) => call.url === configUrl).length).toBe(1)

    // Mid-session model change.
    state.localCurrentModel = { id: "model-b", provider: { id: "prov" } }
    promptValue.splice(0, promptValue.length, { type: "text", content: "next", start: 0, end: 4 })
    await submit.handleSubmit(submitEvent())
    await new Promise<void>((r) => setTimeout(r, 0))
    const matches = unsignedCalls.filter((call) => call.url === configUrl)
    expect(matches.length).toBe(2)
    expect(JSON.parse(matches.at(-1)?.body ?? "{}").model).toEqual({ providerID: "prov", modelID: "model-b" })
  })

})
