import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import type { ComposerMode } from "../mode"
import { buildRequestParts } from "./build-request-parts"
import * as h from "./test-support/submit-harness"
const realBuildRequestParts = buildRequestParts

const PI = { kind: "native", harnessId: "pi" } as const
const CODEX = { kind: "native", harnessId: "codex" } as const
const config = {
  harness: { id: "pi", access: "native" },
  model: { providerID: "provider", modelID: "model" },
  agent: "build",
  variant: null,
}

beforeAll(async () => {
  await h.installSubmitMocks(mock)
  await mock.module("@/features/session/composer/ui/build-request-parts", () => ({ buildRequestParts: realBuildRequestParts }))
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

function setPrompt(content: string) {
  h.promptValue.splice(0, h.promptValue.length, { type: "text", content, start: 0, end: content.length })
}

function sessionSubmit(info?: unknown) {
  return h.createSubmit({
    info: () => info,
    sessionID: () => "session-1",
    sessionDirectory: () => "/repo/main",
    composerMode: () => ({ kind: "session", ref: h.localSessionRef("session-1") }),
    harnessController: { ...h.testHarnessController(), harness: () => PI },
  })
}

test("a draft can send its next turn immediately after session handoff without hydrated picker metadata", async () => {
  let sessionID: string | undefined
  let mode: ComposerMode = { kind: "draft", target: { worktree: "main", hostKind: "self", signedControlPlane: false, harness: PI } }
  const submit = h.createSubmit({
    sessionID: () => sessionID,
    sessionDirectory: () => "/repo/main",
    composerMode: () => mode,
    harnessController: { ...h.testHarnessController(), harness: () => PI },
  })
  setPrompt("first turn")
  await submit.handleSubmit(h.submitEvent())
  await h.waitForSubmitEffect(() => h.calls.transportAsync === 1)
  expect(h.harnessClaimCalls).toHaveLength(1)
  expect(h.calls.transportAsync).toBe(1)

  sessionID = "session-1"
  mode = { kind: "session", ref: h.localSessionRef(sessionID) }
  h.state.localSessionConfig = config
  setPrompt("second turn without reload")
  await submit.handleSubmit(h.submitEvent())
  await h.waitForSubmitEffect(() => h.calls.transportAsync === 2)
  expect(h.toasts).toEqual([])
  expect(h.harnessClaimCalls).toHaveLength(1)
  expect(h.calls.transportAsync).toBe(2)
  expect(h.transportPromptAsyncCalls[1]).toMatchObject({ model: config.model, agent: "build" })
  expect(JSON.stringify(h.transportPromptAsyncCalls[1])).toContain("second turn without reload")
  expect(h.unsignedCalls.filter((call) => call.method === "GET" && call.url.includes("/config"))).toEqual([
    expect.objectContaining({ url: "http://localhost:3001/session/session-1/config?directory=%2Frepo%2Fmain" }),
  ])
})

test("an existing session waits for its authoritative config and never submits with the draft selection", async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>((done) => { resolve = done })
  const hydration = queryClient.fetchQuery({
    queryKey: sessionConfigRawQueryKey({ sessionID: "session-1", directory: "/repo/main", serverUrl: "http://localhost:3001" }),
    queryFn: () => pending,
  })
  const submit = sessionSubmit()
  setPrompt("wait for binding")
  const sending = submit.handleSubmit(h.submitEvent())
  await h.settleSubmitEffects()
  expect(h.calls.transportAsync).toBe(0)
  expect(h.harnessClaimCalls).toEqual([])
  resolve({ ...config, harness: { id: "pi", access: "connection" } })
  await hydration
  await sending
  await h.waitForSubmitEffect(() => h.calls.transportAsync === 1)
  expect(h.calls.transportAsync).toBe(1)
  expect(h.toasts).toEqual([])
  expect(h.runtimeCalls.filter((call) => call.method === "POST" && call.input.includes("/prompt_async"))).toHaveLength(1)
  expect(h.unsignedCalls.filter((call) => call.method === "PATCH")).toEqual([])
  expect(queryClient.getQueryData(sessionConfigRawQueryKey({
    sessionID: "session-1", directory: "/repo/main", serverUrl: "http://localhost:3001",
  }))).toMatchObject({ harness: { id: "pi", access: "connection" } })
})

test("an incomplete authoritative config preserves the prompt and does not synthesize a selection", async () => {
  h.state.localSessionConfig = { harness: { id: "pi", access: "native" } }
  const submit = sessionSubmit({ id: "session-1", config: { ...config, variant: "stale-inventory" } })
  setPrompt("keep this prompt")
  await submit.handleSubmit(h.submitEvent())
  await h.settleSubmitEffects()
  expect(h.calls.transportAsync).toBe(0)
  expect(h.harnessClaimCalls).toEqual([])
  expect(h.promptValue[0]).toMatchObject({ content: "keep this prompt" })
  expect(h.toasts).toEqual([expect.objectContaining({ description: expect.stringContaining("session configuration is not available") })])
})

test("a failed config hydration preserves the prompt and reports the failure instead of using inventory", async () => {
  let reject!: (reason: Error) => void
  const pending = new Promise<unknown>((_, fail) => { reject = fail })
  const hydration = queryClient.fetchQuery({
    queryKey: sessionConfigRawQueryKey({ sessionID: "session-1", directory: "/repo/main", serverUrl: "http://localhost:3001" }),
    queryFn: () => pending,
    retry: false,
  }).catch(() => undefined)
  const submit = sessionSubmit({ id: "session-1", config })
  setPrompt("recover this turn")
  const sending = submit.handleSubmit(h.submitEvent())
  await h.settleSubmitEffects()
  expect(h.calls.transportAsync).toBe(0)
  reject(new Error("Session config authorization failed"))
  await hydration
  await sending
  expect(h.calls.transportAsync).toBe(0)
  expect(h.harnessClaimCalls).toEqual([])
  expect(h.promptValue[0]).toMatchObject({ content: "recover this turn" })
  expect(h.toasts).toEqual([expect.objectContaining({ description: "Session config authorization failed" })])
})

test("a harness held in the picker switches the session, with its model and effort, before the prompt goes out", async () => {
  h.state.localSessionConfig = config
  h.state.heldHarness = CODEX
  h.state.harnessMode = true
  h.state.harnessSubmitModel = { key: { providerID: "codex", modelID: "gpt-5.5", variant: "high" }, name: "GPT-5.5" }
  const submit = sessionSubmit({ id: "session-1" })
  setPrompt("continue on codex")
  await submit.handleSubmit(h.submitEvent())
  await h.waitForSubmitEffect(() => h.calls.transportAsync === 1)

  const configWrites = h.unsignedCalls.filter((call) => call.method === "PATCH" && call.url.includes("/session/session-1/config"))
  expect(JSON.parse(configWrites[0]?.body ?? "{}")).toEqual({
    harness: { id: "codex", access: "native" },
    model: { providerID: "codex", modelID: "gpt-5.5" },
    variant: "high",
  })
  expect(h.state.heldHarness).toBeUndefined()
  expect(h.transportPromptAsyncCalls[0]).toMatchObject({ model: { providerID: "codex", modelID: "gpt-5.5" }, variant: "high" })
  expect(h.toasts).toEqual([])
})

test("a held harness the session cannot switch to sends nothing and keeps the draft and the pick", async () => {
  h.state.localSessionConfig = config
  h.state.heldHarness = CODEX
  h.state.harnessMode = true
  h.state.harnessSubmitModel = { key: { providerID: "codex", modelID: "gpt-5.5" }, name: "GPT-5.5" }
  h.state.sessionConfigSaveError = "Wait for the current turn to finish before switching harness"
  const submit = sessionSubmit({ id: "session-1" })
  setPrompt("keep this for codex")
  await submit.handleSubmit(h.submitEvent())
  await h.settleSubmitEffects()

  expect(h.calls.transportAsync).toBe(0)
  expect(h.optimisticAdds).toEqual([])
  expect(h.promptCalls.reset).toEqual([])
  expect(h.promptValue[0]).toMatchObject({ content: "keep this for codex" })
  expect(h.state.heldHarness).toEqual(CODEX)
  expect(h.toasts).toEqual([expect.objectContaining({ description: "Wait for the current turn to finish before switching harness" })])
})
