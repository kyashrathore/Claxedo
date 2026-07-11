import { beforeEach, describe, expect, test } from "bun:test"
import { createHarnessOptionsLoader, type HarnessOptionsLoaderCache } from "./harness-options-loader"
import type { HarnessOptionsStatePatch } from "../../session/harness/options-state"
import type { HarnessType, OptionsResponse } from "../../session/harness/profile"

const scope = "draft:/repo:route"

let seq: Record<string, number | undefined>
let tries: Record<string, number | undefined>
let harness: HarnessType
let selectedModel: string | undefined
let patches: HarnessOptionsStatePatch[]
let savedModels: string[]
let loading: boolean[]

beforeEach(() => {
  seq = {}
  tries = {}
  harness = "claude-acp"
  selectedModel = "sonnet"
  patches = []
  savedModels = []
  loading = []
})

describe("harness options loader", () => {
  test("applies fresh options and clears retry tries", async () => {
    tries[scope] = 2
    const loader = loaderFor({
      fetch: async () => optionsResponse({
        source: "harness",
        stale: false,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          selectOptions: [{ id: "sonnet", name: "Sonnet" }],
        }],
      }),
    })

    await expect(loader.load(scope, "claude-acp")).resolves.toMatchObject({ source: "harness", stale: false })
    expect(loading).toEqual([true])
    expect(tries[scope]).toBeUndefined()
    expect(patches.at(-1)).toMatchObject({
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      selectedModel: "sonnet",
      optionsLoading: false,
    })
    expect(savedModels).toEqual(["sonnet"])
  })

  test("keeps stale options loading and schedules bounded retry", async () => {
    const responses = [
      optionsResponse({
        source: "empty",
        stale: true,
        options: [],
      }),
      optionsResponse({
        source: "harness",
        stale: false,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          selectOptions: [{ id: "opus", name: "Opus" }],
        }],
      }),
    ]
    let retry: (() => void) | undefined
    const loader = loaderFor({
      fetch: async () => responses.shift()!,
      delay: (run) => {
        retry = run
      },
    })

    await loader.load(scope, "claude-acp")
    expect(tries[scope]).toBe(1)
    expect(patches[0]).toMatchObject({
      dynamicModels: [],
      optionsLoading: true,
      configError: "Loading model options...",
    })
    retry?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tries[scope]).toBeUndefined()
    expect(patches.at(-1)).toMatchObject({
      dynamicModels: [{ id: "opus", name: "Opus" }],
      selectedModel: "opus",
      optionsLoading: false,
      configError: undefined,
    })
  })

  test("ignores stale responses after a newer sequence starts", async () => {
    let resolveFirst: (value: Response) => void = () => {}
    const loader = loaderFor({
      fetch: async (_type, request?: { name?: string }) => {
        if (request?.name === "first") {
          return await new Promise<Response>((resolve) => {
            resolveFirst = resolve
          })
        }
        return optionsResponse({
          source: "harness",
          stale: false,
          options: [],
        })
      },
    })

    const first = loader.load(scope, "claude-acp", { name: "first" })
    await loader.load(scope, "claude-acp", { name: "second" })
    resolveFirst(optionsResponse({
      source: "harness",
      stale: false,
      options: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        selectOptions: [{ id: "sonnet", name: "Sonnet" }],
      }],
    }))

    await expect(first).resolves.toBeUndefined()
    expect(patches).toHaveLength(1)
  })

  test("reports failed responses and thrown fetches only for current sequence", async () => {
    const loader = loaderFor({
      fetch: async () => new Response("nope", { status: 500 }),
      errorMessage: async () => "server said no",
    })

    await expect(loader.load(scope, "claude-acp")).resolves.toBeUndefined()
    expect(patches.at(-1)).toEqual({
      dynamicModels: [],
      optionsSource: "empty",
      optionsStale: true,
      optionsLoading: false,
      configError: "server said no",
    })

    const throwing = loaderFor({
      fetch: async () => {
        throw new Error("network")
      },
    })
    await expect(throwing.load(scope, "claude-acp")).resolves.toBeUndefined()
    expect(patches.at(-1)?.configError).toBe("Failed to load model options")
  })

})

function loaderFor(input: {
  fetch: (type: HarnessType, request?: { name?: string }) => Promise<Response>
  errorMessage?: (res: Response, fallback: string) => Promise<string>
  delay?: (run: () => void) => void
}) {
  return createHarnessOptionsLoader<{ name?: string }>({
    fetch: input.fetch,
    currentHarness: () => harness,
    selectedModel: () => selectedModel,
    seed: () => {},
    applyPatch: (_scope, patch) => patches.push(patch),
    saveModel: (_scope, model) => savedModels.push(model),
    setOptionsLoading: (_scope, value) => loading.push(value),
    errorMessage: input.errorMessage ?? (async (_res, fallback) => fallback),
    scheduleRetry: input.delay,
    cache: fakeCache(),
  })
}

function fakeCache(): HarnessOptionsLoaderCache {
  return {
    nextSeq: (scope) => {
      const next = (seq[scope] ?? 0) + 1
      seq[scope] = next
      return next
    },
    getSeq: (scope) => seq[scope],
    getTries: (scope) => tries[scope],
    setTries: (scope, value) => {
      tries[scope] = value
    },
    clearTries: (scope) => {
      delete tries[scope]
    },
  }
}

function optionsResponse(body: OptionsResponse) {
  return Response.json(body)
}
