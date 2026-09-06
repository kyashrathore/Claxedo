import { connectionHarness, nativeHarness } from "@/platform/identity/harness-selection"
import { beforeEach, describe, expect, test } from "bun:test"
import { createHarnessOptionsLoader, type HarnessOptionsLoaderCache } from "./harness-options-loader"
import type { HarnessOptionsStatePatch } from "./options-state"
import type { HarnessType, OptionsResponse } from "./profile"
import type { DraftDefaultApplication, ResolveDraftDefaultInput } from "./draft-default-policy"

const scope = "draft:/repo:route"

let seq: Record<string, number | undefined>
let tries: Record<string, number | undefined>
let harness: HarnessType
let selectedModel: string | undefined
let patches: HarnessOptionsStatePatch[]
let loading: boolean[]

beforeEach(() => {
  seq = {}
  tries = {}
  harness = connectionHarness("claude-acp")
  selectedModel = "sonnet"
  patches = []
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

    await expect(loader.load(scope, connectionHarness("claude-acp"))).resolves.toMatchObject({ source: "harness", stale: false })
    expect(loading).toEqual([true])
    expect(tries[scope]).toBeUndefined()
    expect(patches.at(-1)).toMatchObject({
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      selectedModel: "sonnet",
      optionsLoading: false,
    })
  })

  test("keeps an equivalent generic connection current across structural copies", async () => {
    harness = connectionHarness("cloud-agent")
    const requested = connectionHarness("cloud-agent")
    const loader = loaderFor({
      fetch: async () => optionsResponse({
        source: "harness",
        stale: false,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "big-pickle-1",
          selectOptions: [{ id: "big-pickle-1", name: "Big Pickle" }],
        }],
      }),
    })

    await loader.load(scope, requested)

    expect(patches.at(-1)).toMatchObject({
      dynamicModels: [{ id: "big-pickle-1", name: "Big Pickle" }],
      selectedModel: "big-pickle-1",
      optionsLoading: false,
    })
    expect(patches).toHaveLength(1)
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

    await loader.load(scope, connectionHarness("claude-acp"))
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

    const first = loader.load(scope, connectionHarness("claude-acp"), { name: "first" })
    await loader.load(scope, connectionHarness("claude-acp"), { name: "second" })
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

    await expect(loader.load(scope, connectionHarness("claude-acp"))).resolves.toBeUndefined()
    expect(patches.at(-1)).toEqual({
      dynamicModels: [],
      selectedModel: "",
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
    await expect(throwing.load(scope, connectionHarness("claude-acp"))).resolves.toBeUndefined()
    expect(patches.at(-1)?.configError).toBe("Failed to load model options")
  })

  test("ignores a failed response after the draft switches to another harness", async () => {
    let finishMessage: (value: string) => void = () => {}
    const loader = loaderFor({
      fetch: async () => new Response("nope", { status: 500 }),
      errorMessage: async () => await new Promise<string>((resolve) => {
        finishMessage = resolve
      }),
    })

    const run = loader.load(scope, connectionHarness("claude-acp"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness = nativeHarness("pi")
    finishMessage("stale failure")

    await expect(run).resolves.toBeUndefined()
    expect(patches).toEqual([])
  })

  test("ignores a rejected request after the draft switches to another harness", async () => {
    let rejectFetch: (reason: Error) => void = () => {}
    const loader = loaderFor({
      fetch: async () => await new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject
      }),
    })

    const run = loader.load(scope, connectionHarness("claude-acp"))
    harness = connectionHarness("another-agent")
    rejectFetch(new Error("stale failure"))

    await expect(run).resolves.toBeUndefined()
    expect(patches).toEqual([])
  })

  test("publishes live config eligibility to a captured draft resolver without substituting first", async () => {
    const captured = { scope, workspaceKey: "ws_1", revision: 2 }
    const resolutions: Array<{
      application: DraftDefaultApplication
      input: Omit<ResolveDraftDefaultInput, "saved">
    }> = []
    const loader = loaderFor({
      fetch: async () => optionsResponse({
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
      }),
      draftDefaultApplication: () => captured,
      resolveDraftDefault: (application, input) => {
        resolutions.push({ application, input })
        return true
      },
    })

    await loader.load(scope, connectionHarness("claude-acp"))

    expect(patches.at(-1)).toEqual({
      optionsSource: "harness",
      optionsStale: false,
      thoughtLevels: [],
      optionsLoading: false,
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
    })
    expect(resolutions).toEqual([{
      application: captured,
      input: {
        supportedHarnesses: [connectionHarness("claude-acp")],
        eligibleModels: [{ providerID: "claude-acp", modelID: "sonnet" }],
        declaredDefaultModel: { providerID: "claude-acp", modelID: "sonnet" },
      },
    }])
  })

  test("keeps a captured default unresolved while options are stale", async () => {
    const resolutions: unknown[] = []
    const loader = loaderFor({
      fetch: async () => optionsResponse({
        source: "catalog",
        stale: true,
        options: [],
      }),
      delay: () => {},
      draftDefaultApplication: () => ({ scope, workspaceKey: "ws_1", revision: 2 }),
      resolveDraftDefault: (_application, input) => {
        resolutions.push(input)
        return true
      },
    })

    await loader.load(scope, connectionHarness("claude-acp"))

    expect(resolutions).toEqual([])
    expect(patches.at(-1)).toMatchObject({
      optionsLoading: true,
      configError: "Loading model options...",
    })
  })

  for (const outcome of ["success", "http-error", "network-error"] as const) {
    test(`a superseded ${outcome} response cannot clear a newer pending load`, async () => {
      const requests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = []
      const loader = loaderFor({
        fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      })
      const abandoned = loader.load(scope, connectionHarness("claude-acp"))
      harness = connectionHarness("codex-acp")
      const current = loader.load(scope, harness)
      expect(loading).toEqual([true, true])

      if (outcome === "network-error") requests[0].reject(new Error("stale network error"))
      else requests[0].resolve(outcome === "http-error"
        ? new Response("stale failure", { status: 500 })
        : optionsResponse({ source: "harness", stale: false, options: [] }))
      await abandoned

      expect(loading).toEqual([true, true])
      expect(patches).toEqual([])

      requests[1].resolve(optionsResponse({ source: "harness", stale: false, options: [] }))
      await current
      expect(patches.at(-1)).toMatchObject({ optionsLoading: false })
    })
  }

  test("a slow duplicate load cannot change the settled winner", async () => {
    let release: (() => void) | undefined
    const first = loaderFor({
      fetch: async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return optionsResponse({ source: "harness", stale: false, options: [] })
      },
    })
    const second = loaderFor({
      fetch: async () => optionsResponse({
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
      }),
    })

    const slow = first.load(scope, connectionHarness("claude-acp"))
    await second.load(scope, connectionHarness("claude-acp"))
    const settled = patches.at(-1)
    release?.()
    await slow

    expect(patches.at(-1)).toBe(settled)
    expect(loading).toEqual([true, true])
  })

  test("releases the loading flag when an abandoned load throws", async () => {
    const loader = loaderFor({
      fetch: async () => {
        harness = connectionHarness("codex-acp")
        throw new Error("network down")
      },
    })

    await loader.load(scope, connectionHarness("claude-acp"))

    expect(loading).toEqual([true, false])
  })

  test("clears placeholder model ids when options loading fails", async () => {
    harness = nativeHarness("cursor")
    selectedModel = "default"
    const loader = loaderFor({
      fetch: async () => new Response(JSON.stringify({ error: "Cursor SDK requires an explicit cursor-sdk API key." }), { status: 502 }),
      errorMessage: async () => "Cursor SDK requires an explicit cursor-sdk API key.",
    })

    await loader.load(scope, nativeHarness("cursor"))

    expect(patches.at(-1)).toMatchObject({
      dynamicModels: [],
      selectedModel: "",
      configError: "Cursor SDK requires an explicit cursor-sdk API key.",
      optionsLoading: false,
    })
  })

  test("does not overwrite a settled harness runtime error with a later live options response", async () => {
    harness = nativeHarness("cursor")
    selectedModel = ""
    const loader = loaderFor({
      fetch: async () => optionsResponse({
        source: "harness",
        stale: false,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "auto",
          selectOptions: [{ id: "auto", name: "Auto" }],
        }],
      }),
      readState: () => ({
        readiness: "error",
        configError: "Cursor SDK requires an explicit cursor-sdk API key.",
      }),
    })

    await loader.load(scope, nativeHarness("cursor"))

    expect(patches).toEqual([])
    expect(loading).toEqual([true, false])
  })

})

function loaderFor(input: {
  fetch: (type: HarnessType, request?: { name?: string }) => Promise<Response>
  errorMessage?: (res: Response, fallback: string) => Promise<string>
  delay?: (run: () => void) => void
  draftDefaultApplication?: () => DraftDefaultApplication | undefined
  resolveDraftDefault?: (
    application: DraftDefaultApplication,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ) => boolean
  readState?: () => { readiness?: string; configError?: string } | undefined
}) {
  return createHarnessOptionsLoader<{ name?: string }>({
    fetch: input.fetch,
    currentHarness: () => harness,
    selectedModel: () => selectedModel,
    seed: () => {},
    applyPatch: (_scope, patch) => patches.push(patch),
    draftDefaultApplication: input.draftDefaultApplication,
    resolveDraftDefault: input.resolveDraftDefault,
    setOptionsLoading: (_scope, value) => loading.push(value),
    readState: input.readState,
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
