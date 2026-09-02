import { beforeEach, describe, expect, test } from "bun:test"
import {
  createHarnessModelWriter,
  syncHarnessSessionModel,
  type HarnessSessionModelSyncCache,
  type SessionModelSyncState,
} from "./harness-model-writer"
import { sessionResourceUrl } from "./harness-config-routes"

const scope = "draft:/repo:route"

let state: Record<string, SessionModelSyncState | undefined>
let pending: Record<string, Promise<void> | undefined>
let seeds: string[]
let selectedModels: Array<{ providerID: string; modelID: string }>
let dropped: string[]
let posts: { url: string; body: unknown }[]
let remembered: Array<{ scope: string; model: { providerID: string; modelID: string }; directory?: string }>
let publishedConfigs: unknown[]
let useLocal: boolean

beforeEach(() => {
  state = {}
  pending = {}
  seeds = []
  selectedModels = []
  dropped = []
  posts = []
  remembered = []
  publishedConfigs = []
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

  test("does not publish an older model response that finishes parsing after a newer choice", async () => {
    let releaseOldJson: (config: unknown) => void = () => {}
    let oldJsonStarted: () => void = () => {}
    const parsing = new Promise<void>((resolve) => {
      oldJsonStarted = resolve
    })
    const published: unknown[] = []
    const oldWrite = syncHarnessSessionModel({
      key: "server\nses_1",
      model: "sonnet",
      cache: fakeCache(),
      publishConfig: (config) => published.push(config),
      request: async () => ({
        ok: true,
        json: () => {
          oldJsonStarted()
          return new Promise((resolve) => {
            releaseOldJson = resolve
          })
        },
      }) as Response,
    })
    await parsing

    const newConfig = { model: "opus" }
    await syncHarnessSessionModel({
      key: "server\nses_1",
      model: "opus",
      cache: fakeCache(),
      publishConfig: (config) => published.push(config),
      request: async () => Response.json(newConfig),
    })
    releaseOldJson({ model: "sonnet" })
    await oldWrite

    expect(published).toEqual([newConfig])
    expect(state["server\nses_1"]).toEqual({ desired: "opus", synced: "opus" })
  })

  test("rejects a failed canonical model update so recovery cannot resend early", async () => {
    const write = syncHarnessSessionModel({
      key: "server\nses_1",
      model: "sonnet",
      cache: fakeCache(),
      request: async () => new Response("model unavailable", { status: 409 }),
    })

    await expect(write).rejects.toThrow("model unavailable")
    expect(state["server\nses_1"]).toEqual({ desired: "sonnet" })
    expect(pending["server\nses_1\nsonnet"]).toBeUndefined()
  })

  test("updates draft model locally and drops prepared runtime sessions without syncing", async () => {
    await writerFor().setModel(scope, { providerID: "anthropic", modelID: "opus" }, { directory: "/repo", sessionId: "new" })

    expect(seeds).toEqual([scope])
    expect(selectedModels).toEqual([{ providerID: "anthropic", modelID: "opus" }])
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
    expect(dropped).toEqual([])
    expect(posts).toEqual([{
      url: sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" }),
      body: { model: { providerID: "anthropic", modelID: "opus" } },
    }])
    expect(remembered).toEqual([])
    expect(Object.values(state)).toEqual([{ desired: "anthropic/opus", synced: "anthropic/opus" }])
    expect(publishedConfigs).toEqual([{
      harness: { id: "claude", access: "native" },
      model: { providerID: "anthropic", modelID: "opus" },
    }])
  })

  test("updates the canonical session config for existing non-local sessions", async () => {
    useLocal = false
    await writerFor().setModel("session:ses_1", { providerID: "anthropic", modelID: "opus" }, { directory: "/repo", sessionId: "ses_1" })

    expect(selectedModels).toEqual([{ providerID: "anthropic", modelID: "opus" }])
    expect(posts).toEqual([{
      url: sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" }),
      body: { model: { providerID: "anthropic", modelID: "opus" } },
    }])
  })

})

function writerFor() {
  return createHarnessModelWriter({
    base: "http://server",
    seed: (scope) => seeds.push(scope),
    acceptsDraftModel: () => true,
    setSelectedModel: (_scope, model) => selectedModels.push(model),
    dropPrepared: (scope) => dropped.push(scope),
    rememberDraftModel: (scope, model, input) => remembered.push({
      scope,
      model,
      directory: input?.directory,
    }),
    publishSessionConfig: (_input, config) => publishedConfigs.push(config),
    runtime: {
      useLocalHarnessConfig: () => useLocal,
      harnessSessionFetch: () => async (url, init) => {
        posts.push({
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        })
        return Response.json({
          harness: { id: "claude", access: "native" },
          model: { providerID: "anthropic", modelID: "opus" },
        })
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
