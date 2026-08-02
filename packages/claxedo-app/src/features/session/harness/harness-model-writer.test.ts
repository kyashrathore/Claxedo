import { beforeEach, describe, expect, test } from "bun:test"
import {
  createHarnessModelWriter,
  syncHarnessSessionModel,
  type HarnessSessionModelSyncCache,
  type SessionModelSyncState,
} from "./harness-model-writer"
import { harnessConfigUrl } from "./harness-config-routes"

const scope = "draft:/repo:route"

let state: Record<string, SessionModelSyncState | undefined>
let pending: Record<string, Promise<void> | undefined>
let seeds: string[]
let selectedModels: Array<{ providerID: string; modelID: string }>
let selectedAgents: string[]
let saved: { key: "model" | "agent"; value: string }[]
let dropped: string[]
let posts: { url: string; body: unknown }[]
let remembered: Array<{ scope: string; model: { providerID: string; modelID: string }; directory?: string }>
let useLocal: boolean

beforeEach(() => {
  state = {}
  pending = {}
  seeds = []
  selectedModels = []
  selectedAgents = []
  saved = []
  dropped = []
  posts = []
  remembered = []
  useLocal = true
})

describe("harness model writer", () => {
  test("dedupes an in-flight session model write through the injected cache", async () => {
    let calls = 0
    let release: (res: Response) => void = () => {}
    const request = () => {
      calls += 1
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }

    const first = syncHarnessSessionModel({ key: "server\nses_1", model: "sonnet", request, cache: fakeCache() })
    const second = syncHarnessSessionModel({ key: "server\nses_1", model: "sonnet", request, cache: fakeCache() })

    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(state["server\nses_1"]).toEqual({ desired: "sonnet" })
    expect(pending["server\nses_1\nsonnet"]).toBe(first)

    release(new Response(null, { status: 204 }))
    await first

    expect(state["server\nses_1"]).toEqual({ desired: "sonnet", synced: "sonnet" })
    expect(pending["server\nses_1\nsonnet"]).toBeUndefined()
  })

  test("does not mark an older write synced after a newer model is desired", async () => {
    let releaseOld: (res: Response) => void = () => {}
    let releaseNew: (res: Response) => void = () => {}

    const oldWrite = syncHarnessSessionModel({
      key: "server\nses_1",
      model: "sonnet",
      cache: fakeCache(),
      request: () =>
        new Promise<Response>((resolve) => {
          releaseOld = resolve
        }),
    })
    const newWrite = syncHarnessSessionModel({
      key: "server\nses_1",
      model: "opus",
      cache: fakeCache(),
      request: () =>
        new Promise<Response>((resolve) => {
          releaseNew = resolve
        }),
    })

    releaseOld(new Response(null, { status: 204 }))
    await oldWrite
    expect(state["server\nses_1"]).toEqual({ desired: "opus" })

    releaseNew(new Response(null, { status: 204 }))
    await newWrite
    expect(state["server\nses_1"]).toEqual({ desired: "opus", synced: "opus" })
  })

  test("updates draft model locally and drops prepared runtime sessions without syncing", async () => {
    await writerFor().setModel(scope, { providerID: "anthropic", modelID: "opus" }, { directory: "/repo", sessionId: "new" })

    expect(seeds).toEqual([scope])
    expect(selectedModels).toEqual([{ providerID: "anthropic", modelID: "opus" }])
    expect(saved).toEqual([{ key: "model", value: '{"providerID":"anthropic","modelID":"opus"}' }])
    expect(dropped).toEqual([scope])
    expect(posts).toEqual([])
    expect(remembered).toEqual([{
      scope,
      model: { providerID: "anthropic", modelID: "opus" },
      directory: "/repo",
    }])
  })

  test("updates existing local model before posting session config", async () => {
    await writerFor().setModel("session:ses_1", { providerID: "anthropic", modelID: "opus" }, { directory: "/repo", sessionId: "ses_1" })

    expect(seeds).toEqual(["session:ses_1"])
    expect(selectedModels).toEqual([{ providerID: "anthropic", modelID: "opus" }])
    expect(saved).toEqual([{ key: "model", value: '{"providerID":"anthropic","modelID":"opus"}' }])
    expect(dropped).toEqual([])
    expect(posts).toEqual([{
      url: harnessConfigUrl({ serverUrl: "http://server", resource: "harness/model" }),
      body: { model: { providerID: "anthropic", modelID: "opus" }, sessionId: "ses_1", directory: "/repo" },
    }])
    expect(remembered).toEqual([])
    expect(state["http://server\nses_1"]).toEqual({ desired: "anthropic/opus", synced: "anthropic/opus" })
  })

  test("skips model sync for existing non-local sessions", async () => {
    useLocal = false
    await writerFor().setModel("session:ses_1", { providerID: "anthropic", modelID: "opus" }, { directory: "/repo", sessionId: "ses_1" })

    expect(selectedModels).toEqual([{ providerID: "anthropic", modelID: "opus" }])
    expect(saved).toEqual([{ key: "model", value: '{"providerID":"anthropic","modelID":"opus"}' }])
    expect(posts).toEqual([])
  })

  test("updates agent locally without dropping prepared sessions or syncing model", () => {
    writerFor().setAgent(scope, "build")

    expect(seeds).toEqual([scope])
    expect(selectedAgents).toEqual(["build"])
    expect(saved).toEqual([{ key: "agent", value: "build" }])
    expect(dropped).toEqual([])
    expect(posts).toEqual([])
  })

})

function writerFor() {
  return createHarnessModelWriter({
    base: "http://server",
    seed: (scope) => seeds.push(scope),
    acceptsDraftModel: () => true,
    setSelectedModel: (_scope, model) => selectedModels.push(model),
    setSelectedAgent: (_scope, name) => selectedAgents.push(name),
    saveModel: (_scope, model) => saved.push({ key: "model", value: model }),
    saveAgent: (_scope, name) => saved.push({ key: "agent", value: name }),
    dropPrepared: (scope) => dropped.push(scope),
    rememberDraftModel: (scope, model, input) => remembered.push({
      scope,
      model,
      directory: input?.directory,
    }),
    runtime: {
      useLocalHarnessConfig: () => useLocal,
      localHarnessConfigFetch: () => async (url, init) => {
        posts.push({
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        })
        return new Response(null, { status: 204 })
      },
    },
    cache: fakeCache(),
  })
}

function fakeCache(): HarnessSessionModelSyncCache {
  return {
    getState: (key) => state[key],
    setState: (key, value) => {
      state[key] = value
    },
    getPending: (key, model) => pending[`${key}\n${model}`],
    setPending: (key, model, value) => {
      pending[`${key}\n${model}`] = value
    },
    removePending: (key, model, value) => {
      const pendingKey = `${key}\n${model}`
      if (pending[pendingKey] === value) delete pending[pendingKey]
    },
  }
}
