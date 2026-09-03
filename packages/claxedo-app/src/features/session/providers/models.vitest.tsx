/**
 * The model store belongs to (server, workspace, harness).
 *
 * It used to be one `Persist.global("model")` bucket fed by the OpenCode
 * catalog, so a model hidden on one machine was hidden on every machine and no
 * non-OpenCode model was ever in it. These render the real `ModelsProvider` and
 * pin the three consequences: the bucket is the workspace, the harness keys the
 * maps inside it, and the replaced global entry migrates exactly once.
 */
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  catalogs: {} as Record<string, Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>>,
  requests: [] as Array<{ harness: string; scope?: string }>,
}))

vi.mock("@/features/session/app-ports", async () => {
  const solid = await import("solid-js")
  return {
    useProviders: (harness: string | (() => string), scope?: string | (() => string | undefined)) => {
      const read = () => ({
        harness: typeof harness === "function" ? harness() : harness,
        scope: typeof scope === "function" ? scope() : scope,
      })
      const connected = solid.createMemo(() => {
        const request = read()
        state.requests.push(request)
        return state.catalogs[request.harness] ?? []
      })
      return {
        state: () => ({ all: new Map(), connected: [], default: {} }),
        loading: () => false,
        error: () => undefined,
        refresh: async () => undefined,
        load: async () => undefined,
        queryKey: () => ["providers"],
        all: () => new Map(connected().map((provider) => [provider.id, provider] as const)),
        default: () => ({}),
        popular: () => [],
        connected,
      }
    },
  }
})

const { ModelsProvider, ModelStoreRegistryProvider, useModels } = await import("./models")
const { Persist } = await import("@/platform/persistence/persist")

const SERVER = "http://127.0.0.1:2593"
const OPUS = { providerID: "anthropic", modelID: "opus" }

function bucket(workspaceKey: string) {
  const target = Persist.serverWorkspace(SERVER, workspaceKey, "model")
  return `${target.storage}:${target.key}`
}

// `Persist` keeps a process-wide read cache keyed by storage name, so a
// workspace key used by an earlier test would answer from it even after
// `localStorage.clear()`. Each test names its own workspaces.
let workspaceSerial = 0
function nextWorkspaceKey(name: string) {
  workspaceSerial += 1
  return `${name}_${workspaceSerial}`
}

function stored(workspaceKey: string) {
  const raw = localStorage.getItem(bucket(workspaceKey))
  return raw ? JSON.parse(raw) : undefined
}

/** Mounts the store for one (workspace, harness) and hands the API to the test. */
function mount(input: { workspaceKey: string; harness: () => string }) {
  let api: ReturnType<typeof useModels> | undefined
  const Probe = () => {
    api = useModels()
    return <div data-testid="mounted" />
  }
  render(() => (
    <ModelStoreRegistryProvider>
      <ModelsProvider
        workspaceKey={() => input.workspaceKey}
        harness={input.harness}
        serverUrl={() => SERVER}
      >
        <Probe />
      </ModelsProvider>
    </ModelStoreRegistryProvider>
  ))
  return () => {
    if (!api) throw new Error("ModelsProvider did not mount")
    return api
  }
}

/**
 * Mounts TWO surfaces on one workspace under ONE registry — the shape the app
 * shell has, with a pane's composer and the Settings Models page open at once.
 */
function mountPair(workspaceKey: string) {
  const api: Array<ReturnType<typeof useModels> | undefined> = [undefined, undefined]
  const Probe = (props: { index: number }) => {
    api[props.index] = useModels()
    return <div data-testid={`mounted-${props.index}`} />
  }
  const Surface = (props: { index: number }) => (
    <ModelsProvider workspaceKey={() => workspaceKey} harness={() => "opencode"} serverUrl={() => SERVER}>
      <Probe index={props.index} />
    </ModelsProvider>
  )
  render(() => (
    <ModelStoreRegistryProvider>
      <Surface index={0} />
      <Surface index={1} />
    </ModelStoreRegistryProvider>
  ))
  return api.map((_, index) => () => {
    const value = api[index]
    if (!value) throw new Error("ModelsProvider did not mount")
    return value
  })
}

beforeEach(() => {
  localStorage.clear()
  state.requests.length = 0
  state.catalogs = {
    opencode: [{ id: "anthropic", name: "Anthropic", models: { opus: { id: "opus", name: "Opus" } } }],
    "claude-sdk": [{ id: "anthropic", name: "Anthropic", models: { opus: { id: "opus", name: "Opus" } } }],
  }
})

afterEach(() => cleanup())

describe("the model store is per (server, workspace, harness)", () => {
  test("visibility, variant and recent are keyed by harness inside one workspace bucket", async () => {
    const workspace = nextWorkspaceKey("ws")
    const [harness, setHarness] = createSignal("opencode")
    const models = mount({ workspaceKey: workspace, harness })

    models().setVisibility(OPUS, false)
    models().variant.set(OPUS, "thinking")
    models().recent.push(OPUS)

    await waitFor(() => expect(stored(workspace)?.user?.opencode).toBeTruthy())
    expect(models().visible(OPUS)).toBe(false)
    expect(models().variant.get(OPUS)).toBe("thinking")
    expect(models().recent.list()).toEqual([OPUS])

    setHarness("claude-sdk")

    // The same provider/model pair under another harness is a different offer.
    expect(models().visible(OPUS)).toBe(false)
    expect(models().variant.get(OPUS)).toBeUndefined()
    expect(models().recent.list()).toEqual([])

    models().setVisibility(OPUS, true)
    await waitFor(() => expect(stored(workspace)?.user?.["claude-sdk"]).toBeTruthy())
    expect(stored(workspace).user.opencode).toEqual([{ ...OPUS, visibility: "hide" }])
    expect(stored(workspace).user["claude-sdk"]).toEqual([{ ...OPUS, visibility: "show" }])
    expect(stored(workspace).recent).toEqual([{ ...OPUS, harness: "opencode" }])
  })

  // Settings and a pane's composer are routinely open on the same workspace at
  // once and edit this one document, so both hold the same record: an edit on
  // one is visible on the other immediately, and neither overwrites the other.
  test("two surfaces on one (server, workspace) read and write the same record", async () => {
    const workspace = nextWorkspaceKey("ws")
    const [pane, settings] = mountPair(workspace)

    settings().setVisibility(OPUS, false)

    expect(pane().visible(OPUS)).toBe(false)
    await waitFor(() => expect(stored(workspace)?.user?.opencode).toEqual([{ ...OPUS, visibility: "hide" }]))

    pane().variant.set(OPUS, "thinking")
    expect(settings().variant.get(OPUS)).toBe("thinking")
  })

  test("another workspace on the same server starts from its own bucket", async () => {
    const one = nextWorkspaceKey("ws")
    const two = nextWorkspaceKey("ws")
    const first = mount({ workspaceKey: one, harness: () => "opencode" })
    first().setVisibility(OPUS, false)
    await waitFor(() => expect(stored(one)?.user?.opencode).toBeTruthy())
    cleanup()

    const second = mount({ workspaceKey: two, harness: () => "opencode" })
    second().setVisibility(OPUS, true)
    await waitFor(() => expect(stored(two)?.user?.opencode).toBeTruthy())
    expect(stored(one).user.opencode).toEqual([{ ...OPUS, visibility: "hide" }])
    expect(stored(two).user.opencode).toEqual([{ ...OPUS, visibility: "show" }])
  })

  test("the store reads the catalog of the harness it is shown for, not an OpenCode-only list", () => {
    const [harness, setHarness] = createSignal("opencode")
    mount({ workspaceKey: nextWorkspaceKey("ws"), harness })
    setHarness("claude-sdk")

    expect(state.requests.map((request) => request.harness)).toContain("claude-sdk")
    expect(state.requests.every((request) => !!request.harness)).toBe(true)
  })

  test("the replaced global store migrates into the first workspace bucket that reads it, once", async () => {
    localStorage.setItem("opencode.global.dat:model", JSON.stringify({
      user: [{ ...OPUS, visibility: "hide" }],
      recent: [OPUS],
      variant: { "anthropic/opus": "thinking" },
    }))

    const first = mount({ workspaceKey: nextWorkspaceKey("ws"), harness: () => "opencode" })
    await waitFor(() => expect(first().variant.get(OPUS)).toBe("thinking"))
    expect(first().visible(OPUS)).toBe(false)
    expect(first().recent.list()).toEqual([OPUS])
    expect(localStorage.getItem("opencode.global.dat:model")).toBeNull()
    cleanup()

    const second = mount({ workspaceKey: nextWorkspaceKey("ws"), harness: () => "opencode" })
    expect(second().variant.get(OPUS)).toBeUndefined()
    expect(second().recent.list()).toEqual([])
  })
})
