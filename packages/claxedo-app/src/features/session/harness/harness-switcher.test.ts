import { beforeEach, describe, expect, test } from "bun:test"
import { createHarnessSwitcher, type HarnessSwitcherCache } from "./harness-switcher"
import type { WorkspaceBoot } from "./harness-config-runtime"
import { sessionResourceUrl } from "./harness-config-routes"
import type { HarnessType } from "./profile"
import type { HarnessStorePatch } from "./store-state"
import { connectionHarness, nativeHarness } from "@/platform/identity/harness-selection"
import { requestUrl } from "@/lib/url"

const scope = "draft:/repo:route"

let pending: Record<string, Promise<void> | undefined>
let patches: HarnessStorePatch[]
let refreshes: { directory?: string; type?: string; draft?: boolean }[]
let optionFetches: { scope: string; type: HarnessType; directory?: string; sessionId?: string }[]
let posts: { url: string; body: unknown }[]
let dropped: string[]
let clearedTries: string[]
let workspace: WorkspaceBoot | undefined
let postResponse: Response
let workspaceCalls: number
let remembered: Array<{ scope: string; type: HarnessType; directory?: string }>
let publishedConfigs: Array<{ sessionId?: string; directory?: string; config: unknown }>

beforeEach(() => {
  pending = {}
  patches = []
  refreshes = []
  optionFetches = []
  posts = []
  dropped = []
  clearedTries = []
  workspace = { kind: "self" }
  postResponse = new Response(null, { status: 204 })
  workspaceCalls = 0
  remembered = []
  publishedConfigs = []
})

describe("harness switcher", () => {
  test("uses provider capabilities to keep a model-less connection submit-ready without probing options", async () => {
    const type = { kind: "connection", connectionId: "external-opencode" } as const
    const switcher = switcherFor({ hasConfigOptions: async () => false })

    await switcher.setHarness(scope, type, { directory: "/repo", sessionId: "new" })

    expect(optionFetches).toEqual([])
    expect(patches).toContainEqual(expect.objectContaining({
      selectedModel: "default",
      dynamicModels: [],
      optionsLoading: false,
      configError: undefined,
    }))
  })

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

    const first = switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "new" })
    const second = switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "new" })

    expect(second).toBe(Object.values(pending)[0])
    expect(workspaceCalls).toBe(1)
    releaseWorkspace({ kind: "provisioner" })
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
        return { kind: "provisioner" }
      },
    })

    const first = switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "new" })
    await switcher.setHarness(scope, connectionHarness("codex-team"), { directory: "/repo", sessionId: "new" })
    releaseFirst({ kind: "provisioner" })
    await first

    expect(remembered).toEqual([{ scope, type: connectionHarness("codex-team"), directory: "/repo" }])
    expect(optionFetches).toEqual([{ scope, type: connectionHarness("codex-team"), directory: "/repo", sessionId: "new" }])
  })

  test("keeps a draft selection local until session creation", async () => {
    const switcher = switcherFor()

    await switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "new" }, "/bin/claude")

    expect(dropped).toEqual([scope])
    expect(clearedTries).toEqual([scope])
    expect(patches[0]).toMatchObject({
      harness: connectionHarness("claude-team"),
      optionsLoading: true,
      readiness: "ready",
    })
    expect(posts).toEqual([])
    expect(optionFetches).toEqual([{ scope, type: connectionHarness("claude-team"), directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: true }])
    expect(remembered).toEqual([{ scope, type: connectionHarness("claude-team"), directory: "/repo" }])
  })

  test("an abandoned switch cannot clear the newer selection's loading state", async () => {
    const releases: Array<(value: WorkspaceBoot) => void> = []
    const switcher = switcherFor({
      workspace: () => new Promise((resolve) => releases.push(resolve)),
    })
    const abandoned = switcher.setHarness(scope, connectionHarness("codex-team"), { directory: "/repo", sessionId: "new" })
    const current = switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "new" })
    const currentPatches = [...patches]
    expect(currentPatches.at(-1)).toMatchObject({ harness: connectionHarness("claude-team"), optionsLoading: true })

    releases[0]({ kind: "self" })
    await abandoned

    expect(patches).toEqual(currentPatches)
    expect(optionFetches).toEqual([])
    expect(remembered).toEqual([])

    releases[1]({ kind: "self" })
    await current
    expect(optionFetches).toEqual([{ scope, type: connectionHarness("claude-team"), directory: "/repo", sessionId: "new" }])
    expect(remembered).toEqual([{ scope, type: connectionHarness("claude-team"), directory: "/repo" }])
  })

  test("skips the local draft post for provisioner-placed and machine-placed workspace boots", async () => {
    workspace = { kind: "provisioner" }
    const switcher = switcherFor()

    await switcher.setHarness(scope, connectionHarness("codex-team"), { directory: "/repo", sessionId: "new" })

    expect(posts).toEqual([])
    expect(optionFetches).toEqual([{ scope, type: connectionHarness("codex-team"), directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: true }])
  })

  test("switches non-local existing sessions through canonical session config", async () => {
    const switcher = switcherFor()

    await switcher.setHarness("session:ses_1", nativeHarness("cursor"), { directory: "/repo", sessionId: "ses_1" })

    expect(posts).toEqual([{
      url: `${sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" })}&nativeHarness=cursor`,
      body: {},
    }])
    expect(optionFetches).toEqual([{ scope: "session:ses_1", type: nativeHarness("cursor"), directory: "/repo", sessionId: "ses_1" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: undefined }])
    expect(publishedConfigs).toEqual([{
      sessionId: "ses_1",
      directory: "/repo",
      config: { harness: { id: "cursor", access: "native" } },
    }])
  })

  test("does not publish an older harness response that finishes parsing after a newer choice", async () => {
    let releaseOldJson: (config: unknown) => void = () => {}
    let oldJsonStarted: () => void = () => {}
    const parsing = new Promise<void>((resolve) => {
      oldJsonStarted = resolve
    })
    let calls = 0
    const switcher = switcherFor({
      sessionFetch: async (_url, _init) => {
        calls += 1
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
        return Response.json({ harness: { id: "codex", access: "native" } })
      },
    })

    const oldSwitch = switcher.setHarness("session:ses_1", nativeHarness("claude"), { directory: "/repo", sessionId: "ses_1" })
    await parsing
    await switcher.setHarness("session:ses_1", nativeHarness("codex"), { directory: "/repo", sessionId: "ses_1" })
    releaseOldJson({ harness: { id: "claude", access: "native" } })
    await oldSwitch

    expect(publishedConfigs).toEqual([{
      sessionId: "ses_1",
      directory: "/repo",
      config: { harness: { id: "codex", access: "native" } },
    }])
  })

  test("switches an existing model-less connection without probing config options", async () => {
    const switcher = switcherFor({ hasConfigOptions: async () => false })
    const selection = connectionHarness("external-opencode")

    await switcher.setHarness("session:ses_1", selection, { directory: "/repo", sessionId: "ses_1" })

    expect(posts).toEqual([{
      url: `${sessionResourceUrl({ serverUrl: "http://server", resource: "config", sessionID: "ses_1", directory: "/repo" })}&connectionId=external-opencode`,
      body: {},
    }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: undefined }])
    expect(optionFetches).toEqual([])
    expect(patches.at(-1)).toEqual({
      selectedModel: "default",
      dynamicModels: [],
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
  })

  test("records existing-session switch failures as readiness errors", async () => {
    postResponse = Response.json({ error: { message: "binary missing" } }, { status: 500 })
    const switcher = switcherFor()

    await switcher.setHarness(scope, connectionHarness("claude-team"), { directory: "/repo", sessionId: "ses_1" })

    expect(patches.at(-1)).toEqual({
      configError: "binary missing",
      readiness: "error",
      optionsLoading: false,
    })
    expect(refreshes).toEqual([])
    expect(optionFetches).toEqual([])
    expect(remembered).toEqual([])
  })

})

function switcherFor(input?: {
  workspace?: () => Promise<WorkspaceBoot | undefined>
  sessionFetch?: typeof fetch
  hasConfigOptions?: (type: HarnessType) => Promise<boolean>
}) {
  return createHarnessSwitcher({
    base: "http://server",
    seed: () => {},
    dropPrepared: (scope) => dropped.push(scope),
    applyPatch: (_scope, patch) => patches.push(patch),
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
    hasConfigOptions: input?.hasConfigOptions,
    errorMessage: async (res, fallback) => {
      const body = await res.json().catch(() => undefined) as { error?: string | { message?: string } } | undefined
      if (typeof body?.error === "string") return body.error
      if (typeof body?.error?.message === "string") return body.error.message
      return fallback
    },
    runtime: {
      harnessSessionFetch: () => input?.sessionFetch ?? (async (url, init) => {
        posts.push({
          url: requestUrl(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        })
        const target = new URL(requestUrl(url))
        const native = target.searchParams.get("nativeHarness")
        const connection = target.searchParams.get("connectionId")
        return postResponse.status === 204
          ? Response.json({ harness: native
            ? { id: native, access: "native" }
            : { id: connection, access: "connection" } })
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
