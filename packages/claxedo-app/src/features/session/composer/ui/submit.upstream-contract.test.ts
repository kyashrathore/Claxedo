import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import * as h from "./submit.harness.test"

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
} = h

beforeAll(async () => {
  await h.installSubmitMocks(mock)
})
beforeEach(() => h.resetSubmitHarness())
afterAll(() => h.restoreSubmitMocks(mock))

describe("upstream contract", () => {
  test("keeps reading the latest worktree accessor value per submit", async () => {
    state.demoMode = false
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
      newSessionWorkspaceKind: () => "local",
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
    state.demoMode = false

    const submit = createSubmit({
      autoAccept: () => true,
      newSessionWorktree: () => "/repo/main",
      newSessionWorkspaceKind: () => "local",
    })

    await submit.handleSubmit(submitEvent())

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/main" }])
  })

  test("keeps the selected variant on optimistic prompts", async () => {
    state.demoMode = false

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
    state.demoMode = false
    state.harnessMode = true
    state.localCurrentModel = { id: "stale-model", provider: { id: "stale-provider" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.localSessionConfig = {
      harness: { id: "opencode" },
      agent: "build",
      model: { providerID: "opencode", modelID: "big-pickle" },
    }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "opencode" },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
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
      model: { providerID: "opencode", modelID: "big-pickle" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config") && call.method === "PATCH")).toEqual([])
  })

  test("existing structured ACP follow-up does not fall back to OpenCode", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = { id: "big-pickle", provider: { id: "opencode" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.localSessionConfig = {
      harness: { id: "claude", access: "acp" },
      agent: "build",
      model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    }

    const submit = createSubmit({
      info: () => ({
        id: "session-1",
        config: {
          harness: { id: "claude", access: "acp" },
          agent: "build",
          model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
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
      model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    })
    expect(unsignedCalls.filter((call) => call.url.includes("/config") && call.method === "PATCH")).toEqual([])
    expect(harnessSetCalls).toEqual([])
  })

  test("existing workspace-runtime follow-up uses cached session config when info config is not hydrated", async () => {
    state.demoMode = false
    state.harnessMode = false
    state.localCurrentModel = { id: "big-pickle", provider: { id: "opencode" } }
    state.localCurrentAgent = { name: "stale-agent" }
    state.runtimeSessionConfig = {
      harness: { type: "codex-acp" },
      agent: "build",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    }
    queryClient.setQueryData(sessionConfigRawQueryKey({
      sessionID: "session-1",
      directory: "ws_1",
      serverUrl: "http://localhost:3001",
    }), {
      harness: { type: "codex-acp" },
      agent: "build",
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
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
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    })
    expect(runtimeCalls.filter((call) => call.input.includes("/config") && call.method === "PATCH")).toEqual([])
    expect(harnessSetCalls).toEqual([])
  })

  test("the authoritative session config wins over stale session-list model metadata", async () => {
    state.demoMode = false
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
    state.demoMode = false
    const submit = createSubmit()

    await submit.handleSubmit(submitEvent())
    await settleSubmitEffects()

    expect(calls.create).toBe(1)
    expect(optimisticAdds).toHaveLength(1)
    expect(optimisticAdds[0]?.sessionID).toBe("session-1")
  })
})
