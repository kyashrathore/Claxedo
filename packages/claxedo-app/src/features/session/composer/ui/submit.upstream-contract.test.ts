import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import * as h from "./test-support/submit-harness"

const {
  createSubmit,
  submitEvent,
  settleSubmitEffects,
  waitForSubmitEffect,
  seedProjectCatalog,
  state,
  calls,
  optimisticAdds,
  apiCalls,
  worktreeCreateCalls,
  enabledAutoAccept,
  transportPromptAsyncCalls,
  unsignedCalls,
  runtimeCalls,
  harnessSetCalls,
  harnessClaimCalls,
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("upstream contract", () => {
  test("keeps reading the latest worktree accessor value per submit", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    let selected = "/repo/worktree-a"
    state.syncProject = {
      id: "project-1",
      worktree: "/repo/main",
      sandboxes: ["/repo/worktree-a", "/repo/worktree-b"],
      workspaces: {
        "/repo/main": { kind: "local" },
        "/repo/worktree-a": { kind: "local" },
        "/repo/worktree-b": { kind: "local" },
      },
    }
    state.globalProjects = [state.syncProject]
    seedProjectCatalog()

    const submit = createSubmit({
      newSessionWorktree: () => selected,
      newSessionHostKind: () => "self",
    })

    await submit.handleSubmit(submitEvent())
    selected = "/repo/worktree-b"
    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(optimisticAdds.map((item) => item.directory)).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(apiCalls.some((item) => new URL(item.url).pathname === "/api/workspace/create")).toBe(false)
    expect(worktreeCreateCalls).toEqual([])
  })

  test("keeps applying auto-accept to newly created sessions", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

    const submit = createSubmit({
      autoAccept: () => true,
      newSessionWorktree: () => "/repo/main",
      newSessionHostKind: () => "self",
    })

    await submit.handleSubmit(submitEvent())

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/main" }])
  })

  test("keeps the selected variant on optimistic prompts", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
      variant: () => "high",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(optimisticAdds.at(-1)?.message?.model?.variant).toBe("high")
    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({ variant: "high" })
  })

  test("existing follow-up submits keep the persisted session config after reload", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = true
    state.localCurrentModel = { id: "stale-model", provider: { id: "stale-provider" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.localSessionConfig = {
      harness: { id: "claude-team", access: "connection" },
      agent: "build",
      model: { providerID: "claude-team", modelID: "big-pickle" },
    }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "claude-team", access: "connection" },
          agent: "build",
          model: { providerID: "claude-team", modelID: "big-pickle" },
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
      agent: "build",
      model: { providerID: "claude-team", modelID: "big-pickle" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config") && call.method === "PATCH")).toEqual([])
  })

  test("existing connection-backed follow-up keeps its authoritative config", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = false
    state.localCurrentModel = { id: "big-pickle", provider: { id: "stale-provider" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.localSessionConfig = {
      harness: { id: "claude-team", access: "connection" },
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "claude-team", access: "connection" },
          agent: "build",
          model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
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
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config") && call.method === "PATCH")).toEqual([])
    expect(harnessSetCalls).toEqual([])
  })

  test("existing workspace-runtime follow-up uses cached session config when info config is not hydrated", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = false
    state.localCurrentModel = { id: "big-pickle", provider: { id: "stale-provider" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.runtimeSessionConfig = {
      harness: { id: "acp:codex", access: "connection" },
      agent: "build",
      model: { providerID: "acp:codex", modelID: "gpt-5.5" },
    }
    queryClient.setQueryData(sessionConfigRawQueryKey({
      sessionID: "session-1",
      directory: "ws_1",
      serverUrl: "http://localhost:3001",
    }), {
      harness: { id: "acp:codex", access: "connection" },
      agent: "build",
      model: { providerID: "acp:codex", modelID: "gpt-5.5" },
    })

    const submit = createSubmit({
      info: () => ({ id: "session-1" }),
      sessionID: () => "session-1",
      sessionDirectory: () => "ws_1",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      sessionID: "session-1",
      directory: "ws_1",
      agent: "build",
      model: { providerID: "acp:codex", modelID: "gpt-5.5" },
    })
    expect(runtimeCalls.filter((call) => call.input.includes("/config"))).toEqual([])
    expect(harnessSetCalls).toEqual([])
  })

  test("the authoritative session config wins over stale session-list model metadata", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    state.harnessMode = true
    state.localSessionConfig = {
      harness: { id: "claude", access: "native" },
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "claude", access: "native" },
          agent: "build",
          model: { providerID: "claude-sdk", modelID: "opus[1m]" },
        },
      }),
      sessionID: () => "session-1",
      sessionDirectory: () => "/repo/main",
    })

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()
    await waitForSubmitEffect(() => calls.transportAsync > 0)

    expect(transportPromptAsyncCalls.at(-1)).toMatchObject({
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    })
  })

  test("keeps upstream ordering by adding the optimistic prompt only after session creation", async () => {
    state.runtimeSessionUrl = "http://runtime.example.com"
    let resolveClaim!: (session: { id: string }) => void
    state.harnessClaimSession = new Promise((resolve) => { resolveClaim = resolve })
    const submit = createSubmit()

    const submitting = submit.handleSubmit(submitEvent())
    await waitForSubmitEffect(() => harnessClaimCalls.length === 1)
    expect(harnessClaimCalls).toHaveLength(1)
    expect(optimisticAdds).toEqual([])

    resolveClaim({ id: "session-1" })
    await submitting
    await settleSubmitEffects()

    expect(calls.create).toBe(0)
    expect(harnessClaimCalls).toHaveLength(1)
    expect(optimisticAdds).toHaveLength(1)
    expect(optimisticAdds[0]?.sessionID).toBe("session-1")
  })
})
