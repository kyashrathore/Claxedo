import { beforeEach, describe, expect, test } from "bun:test"
import { createHarnessSwitcher, type HarnessSwitcherCache } from "./harness-switcher"
import type { WorkspaceBoot } from "./harness-config-runtime"
import type { HarnessType } from "./profile"
import type { HarnessStorePatch } from "./store-state"
import { connectionHarness, nativeHarness, sameHarnessSelection } from "@/platform/identity/harness-selection"

const scope = "draft:/repo:route"

let pending: Record<string, Promise<void> | undefined>
let patches: HarnessStorePatch[]
let refreshes: { directory?: string; type?: string; draft?: boolean }[]
let optionFetches: { scope: string; type: HarnessType; directory?: string; sessionId?: string }[]
let dropped: string[]
let clearedTries: string[]
let workspace: WorkspaceBoot | undefined
let workspaceCalls: number
let remembered: Array<{ scope: string; type: HarnessType; directory?: string }>
let held: Array<{ scope: string; patch: HarnessStorePatch }>
let heldFrom: HarnessType | undefined

beforeEach(() => {
  pending = {}
  patches = []
  refreshes = []
  optionFetches = []
  dropped = []
  clearedTries = []
  workspace = { kind: "self" }
  workspaceCalls = 0
  remembered = []
  held = []
  heldFrom = undefined
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
    expect(held).toEqual([])
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

    expect(optionFetches).toEqual([{ scope, type: connectionHarness("codex-team"), directory: "/repo", sessionId: "new" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: true }])
  })

  test("holds an existing session's pick in the composer and loads the picked harness's options", async () => {
    const switcher = switcherFor()

    await switcher.setHarness("session:ses_1", nativeHarness("cursor"), { directory: "/repo", sessionId: "ses_1" })

    expect(held).toEqual([{
      scope: "session:ses_1",
      patch: expect.objectContaining({ harness: nativeHarness("cursor"), optionsLoading: true, readiness: "ready" }),
    }])
    expect(patches).toEqual([])
    expect(optionFetches).toEqual([{ scope: "session:ses_1", type: nativeHarness("cursor"), directory: "/repo", sessionId: "ses_1" }])
    expect(refreshes).toEqual([{ directory: "/repo", type: undefined, draft: true }])
    expect(remembered).toEqual([])
  })

  test("picking an existing session's own harness back restores it without loading anything", async () => {
    heldFrom = nativeHarness("claude")
    const switcher = switcherFor()

    await switcher.setHarness("session:ses_1", nativeHarness("claude"), { directory: "/repo", sessionId: "ses_1" })

    expect(held).toEqual([])
    expect(optionFetches).toEqual([])
    expect(refreshes).toEqual([])
    expect(workspaceCalls).toBe(0)
  })

  test("holds an existing session's model-less connection without probing config options", async () => {
    const switcher = switcherFor({ hasConfigOptions: async () => false })
    const selection = connectionHarness("external-opencode")

    await switcher.setHarness("session:ses_1", selection, { directory: "/repo", sessionId: "ses_1" })

    expect(held).toEqual([{ scope: "session:ses_1", patch: expect.objectContaining({ harness: selection }) }])
    expect(optionFetches).toEqual([])
    expect(patches.at(-1)).toEqual({
      selectedModel: "default",
      dynamicModels: [],
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    })
  })

})

function switcherFor(input?: {
  workspace?: () => Promise<WorkspaceBoot | undefined>
  hasConfigOptions?: (type: HarnessType) => Promise<boolean>
}) {
  return createHarnessSwitcher({
    base: "http://server",
    seed: () => {},
    dropPrepared: (scope) => dropped.push(scope),
    applyPatch: (_scope, patch) => patches.push(patch),
    holdHarness: (scope, patch) => held.push({ scope, patch }),
    restoreHeldHarness: (_scope, type) => sameHarnessSelection(heldFrom, type),
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
    hasConfigOptions: input?.hasConfigOptions,
    runtime: {
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
