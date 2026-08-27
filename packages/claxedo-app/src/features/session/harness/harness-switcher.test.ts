import { beforeEach, describe, expect, test } from "bun:test"
import { createHarnessSwitcher, type HarnessSwitcherCache } from "./harness-switcher"
import type { WorkspaceBoot } from "./harness-config-runtime"
import { harnessConfigUrl, sessionResourceUrl } from "./harness-config-routes"
import { effectiveHarnessModel, type HarnessType } from "./profile"
import type { HarnessStorePatch } from "./store-state"

const scope = "draft:/repo:route"

let pending: Record<string, Promise<void> | undefined>
let patches: HarnessStorePatch[]
let saved: { key: "harness" | "model"; value: string }[]
let refreshes: { directory?: string; type?: string; draft?: boolean }[]
let optionFetches: { scope: string; type: HarnessType; directory?: string; sessionId?: string }[]
let posts: { url: string; body: unknown }[]
let dropped: string[]
let clearedTries: string[]
let workspace: WorkspaceBoot | undefined
let useLocal: boolean
let postResponse: Response
let statusResponse: Response
let postRelease: (() => void) | undefined
let workspaceCalls: number
let remembered: Array<{ scope: string; type: HarnessType; directory?: string }>
let publishedConfigs: Array<{ sessionId?: string; directory?: string; config: unknown }>

beforeEach(() => {
  pending = {}
  patches = []
  saved = []
  refreshes = []
  optionFetches = []
  posts = []
  dropped = []
  clearedTries = []
  workspace = { kind: "local" }
  useLocal = true
  postResponse = new Response(null, { status: 204 })
  statusResponse = Response.json({ type: "claude-acp", status: "ready", ready: true })
  postRelease = undefined
  workspaceCalls = 0
  remembered = []
  publishedConfigs = []
})

describe("harness switcher", () => {
  test("dedupes in-flight switches through the injected cache", async () => {
    let releaseWorkspace: (value: WorkspaceBoot) => void = () => {}
    const switcher = switcherFor({
      workspace: async () => {
        workspaceCalls += 1
        return await new Promise<WorkspaceBoot>((resolve) => {
          releaseWorkspace = resolve
        })
      },
    })

    const first = switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" })
    const second = switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" })

    expect(second).toBe(Object.values(pending)[0])
    expect(workspaceCalls).toBe(1)
    releaseWorkspace({ kind: "cloud" })
    await Promise.all([first, second])
    expect(Object.values(pending).filter(Boolean)).toEqual([])
  })

  test("discards completion from an older overlapping harness switch", async () => {
    let releaseFirst: (value: WorkspaceBoot) => void = () => {}
    let calls = 0
    const switcher = switcherFor({
      workspace: async () => {
        calls += 1
        if (calls === 1) {
          return await new Promise<WorkspaceBoot>((resolve) => {
            releaseFirst = resolve
          })
        }
        return { kind: "cloud" }
      },
    })

    const first = switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" })
    await switcher.setHarness(scope, "codex-acp", { directory: "/repo", sessionId: "new" })
    releaseFirst({ kind: "cloud" })
    await first

    expect(remembered).toEqual([{ scope, type: "codex-acp", directory: "/repo" }])
    expect(optionFetches).toEqual([{ scope, type: "codex-acp", directory: "/repo", sessionId: "new" }])
  })

  test("switches a local draft by posting config, fetching options, and refreshing quietly", async () => {
    const switcher = switcherFor()

    await switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" }, "/bin/claude")

    expect(dropped).toEqual([scope])
    expect(clearedTries).toEqual([scope])
    expect(saved).toEqual([
      { key: "harness", value: "claude-acp" },
      { key: "model", value: effectiveHarnessModel("claude-acp") },
    ])
    expect(patches[0]).toMatchObject({
      harness: "claude-acp",
      optionsLoading: true,
      readiness: "ready",
    })
    expect(posts).toEqual([{
      url: harnessConfigUrl({ serverUrl: "http://server" }),
      body: { type: "claude-acp", binary: "/bin/claude", directory: "/repo" },
    }])
    expect(optionFetches).toEqual([{ scope, type: "claude-acp", directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: "claude-acp", draft: true }])
    expect(remembered).toEqual([{ scope, type: "claude-acp", directory: "/repo" }])
  })

  // The codex-acp Tier R repro. `setHarnessOnce` opens with
  // `harnessSwitchStartPatch`, which sets `optionsLoading: true` for any
  // harness that has config options — BEFORE the first `await`. Every
  // abandon path after that (`!active()` once the workspace boot, the config
  // POST, or the refresh resolves) returned without clearing it, and no
  // options fetch was ever issued to clear it later. The model control renders
  // "Loading models" straight off that flag with no other exit, so an
  // abandoned switch stranded the composer for the life of the scope. Codex hit
  // this most because its options endpoint is the slowest (~4s cold against a
  // real binary), leaving the widest window for a supersede.
  test("clears the loading flag when a switch is abandoned before options are fetched", async () => {
    let releaseWorkspace: (value: WorkspaceBoot) => void = () => {}
    let firstBoot = true
    const switcher = switcherFor({
      workspace: async () => {
        if (!firstBoot) return { kind: "local" }
        firstBoot = false
        return await new Promise<WorkspaceBoot>((resolve) => {
          releaseWorkspace = resolve
        })
      },
    })

    // The first switch parks on its workspace boot; a second switch for a
    // different harness bumps the scope revision, so the first is abandoned the
    // moment it resumes.
    const abandoned = switcher.setHarness(scope, "codex-acp", { directory: "/repo", sessionId: "new" })
    void switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" })
    releaseWorkspace({ kind: "local" })
    await abandoned

    expect(patches[0]).toMatchObject({ harness: "codex-acp", optionsLoading: true })
    expect(optionFetches.some((item) => item.type === "codex-acp")).toBe(false)
    // The abandoned switch must release the flag it raised: the last word on
    // `optionsLoading` from any patch it emitted is `false`, never a dangling
    // `true` that nothing else will ever lower.
    const loadingPatches = patches.filter((patch) => patch.optionsLoading !== undefined)
    expect(loadingPatches.at(-1)?.optionsLoading).toBe(false)
  })

  test("skips the local draft post for cloud and user-hosted workspace boots", async () => {
    workspace = { kind: "cloud" }
    const switcher = switcherFor()

    await switcher.setHarness(scope, "codex-acp", { directory: "/repo", sessionId: "new" })

    expect(posts).toEqual([])
    expect(optionFetches).toEqual([{ scope, type: "codex-acp", directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: "codex-acp", draft: true }])
  })

  test("switches non-local existing sessions through canonical session config", async () => {
    useLocal = false
    const switcher = switcherFor()

    await switcher.setHarness("session:ses_1", "cursor-acp", { directory: "/repo", sessionId: "ses_1" })

    expect(posts).toEqual([{
      url: sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" }),
      body: { harness: { id: "cursor", access: "acp" } },
    }])
    expect(optionFetches).toEqual([{ scope: "session:ses_1", type: "cursor-acp", directory: "/repo", sessionId: "ses_1" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: "cursor-acp", draft: undefined }])
    expect(publishedConfigs).toEqual([{
      sessionId: "ses_1",
      directory: "/repo",
      config: { harness: { id: "cursor", access: "acp" } },
    }])
  })

  test("does not publish an older harness response that finishes parsing after a newer choice", async () => {
    useLocal = false
    let releaseOldJson: (config: unknown) => void = () => {}
    let oldJsonStarted: () => void = () => {}
    const parsing = new Promise<void>((resolve) => {
      oldJsonStarted = resolve
    })
    let calls = 0
    const switcher = switcherFor({
      sessionFetch: async (_url, init) => {
        calls += 1
        const harness = JSON.parse(String(init?.body)).harness
        if (calls === 1) {
          return {
            ok: true,
            json: () => {
              oldJsonStarted()
              return new Promise((resolve) => {
                releaseOldJson = resolve
              })
            },
          } as Response
        }
        return Response.json({ harness })
      },
    })

    const oldSwitch = switcher.setHarness("session:ses_1", "claude-sdk", { directory: "/repo", sessionId: "ses_1" })
    await parsing
    await switcher.setHarness("session:ses_1", "codex-app-server", { directory: "/repo", sessionId: "ses_1" })
    releaseOldJson({ harness: { id: "claude", access: "native" } })
    await oldSwitch

    expect(publishedConfigs).toEqual([{
      sessionId: "ses_1",
      directory: "/repo",
      config: { harness: { id: "codex", access: "native" } },
    }])
  })

  test("switches a local existing session and clears non-config harness options", async () => {
    const switcher = switcherFor()

    await switcher.setHarness("session:ses_1", "opencode", { directory: "/repo", sessionId: "ses_1" }, "")

    expect(posts).toEqual([{
      url: sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" }),
      body: { harness: { id: "opencode", access: "native" } },
    }])
    expect(refreshes).toEqual([{ directory: "/repo", type: "opencode", draft: undefined }])
    expect(optionFetches).toEqual([])
    expect(patches.at(-1)).toEqual({
      harnessBinary: "",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
  })

  test("records local switch failures as readiness errors", async () => {
    postResponse = Response.json({ error: { message: "binary missing" } }, { status: 500 })
    const switcher = switcherFor()

    await switcher.setHarness(scope, "claude-acp", { directory: "/repo", sessionId: "new" })

    expect(patches.at(-1)).toEqual({
      configError: "binary missing",
      readiness: "error",
      optionsLoading: false,
    })
    expect(refreshes).toEqual([])
    expect(optionFetches).toEqual([])
    expect(remembered).toEqual([])
  })

  test("applies unavailable status from successful local switch responses", async () => {
    statusResponse = Response.json({
      harness: { id: "codex", access: "native" },
      model: "gpt-5.5",
      status: "configured",
      ready: false,
    })
    const switcher = switcherFor()

    await switcher.setHarness(scope, "codex-app-server", { directory: "/repo", sessionId: "new" })

    expect(patches).toContainEqual(expect.objectContaining({
      harness: "codex-app-server",
      selectedModel: "gpt-5.5",
      readiness: "error",
    }))
    expect(optionFetches).toEqual([{ scope, type: "codex-app-server", directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: "codex-app-server", draft: true }])
  })

})

function switcherFor(input?: {
  workspace?: () => Promise<WorkspaceBoot | undefined>
  sessionFetch?: typeof fetch
}) {
  return createHarnessSwitcher({
    base: "http://server",
    seed: () => {},
    dropPrepared: (scope) => dropped.push(scope),
    applyPatch: (_scope, patch) => patches.push(patch),
    saveHarness: (_scope, type) => saved.push({ key: "harness", value: type }),
    saveModel: (_scope, model) => saved.push({ key: "model", value: model }),
    rememberDraftHarness: (scope, type, params) => remembered.push({
      scope,
      type,
      directory: params?.directory,
    }),
    refresh: async (directory, type, opts) => {
      refreshes.push({ directory, type, draft: opts?.draft })
    },
    fetchConfigOptions: (scope, type, params) => {
      optionFetches.push({ scope, type, directory: params?.directory, sessionId: params?.sessionId })
    },
    publishSessionConfig: (params, config) => {
      publishedConfigs.push({ sessionId: params.sessionId, directory: params.directory, config })
    },
    errorMessage: async (res, fallback) => {
      const body = await res.json().catch(() => undefined) as { error?: string | { message?: string } } | undefined
      if (typeof body?.error === "string") return body.error
      if (typeof body?.error?.message === "string") return body.error.message
      return fallback
    },
    runtime: {
      useLocalHarnessConfig: () => useLocal,
      localHarnessConfigFetch: () => async (url, init) => {
        if (!init?.method || init.method === "GET") return statusResponse
        posts.push({
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        })
        await new Promise<void>((resolve) => {
          if (!postRelease) {
            resolve()
            return
          }
          const previous = postRelease
          postRelease = () => {
            previous()
            resolve()
          }
        })
        return postResponse
      },
      harnessSessionFetch: () => input?.sessionFetch ?? (async (url, init) => {
        posts.push({
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        })
        return postResponse.status === 204
          ? Response.json({ harness: JSON.parse(String(init?.body)).harness })
          : postResponse
      }),
      workspace: input?.workspace ?? (async () => workspace),
    },
    cache: fakeCache(),
  })
}

function fakeCache(): HarnessSwitcherCache {
  return {
    getPending: (key) => pending[key],
    setPending: (key, value) => {
      pending[key] = value
    },
    removePending: (key, value) => {
      if (pending[key] === value) delete pending[key]
    },
    clearOptionsTries: (scope) => {
      clearedTries.push(scope)
    },
  }
}
