import { beforeEach, describe, expect, test } from "bun:test"
import {
  createPreparedRuntimeSessionStore,
  type PreparedRuntimeSessionCache,
  type PreparedRuntimeSessionPending,
} from "./harness-prepared-runtime-session"
import type { PreparedRuntimeSession } from "../../session-client/harness/prepared-session"
import type { HarnessType } from "../../session-client/harness/profile"

const scope = "draft:/repo:route"
const prepared = {
  id: "ses_prepared",
  directory: "/repo",
  harness: "claude-acp",
  model: "sonnet",
} satisfies PreparedRuntimeSession

let seq: Record<string, number | undefined>
let preparedCache: Record<string, PreparedRuntimeSession | undefined>
let pending: Record<string, PreparedRuntimeSessionPending | undefined>

beforeEach(() => {
  seq = {}
  preparedCache = {}
  pending = {}
})

describe("prepared runtime session store", () => {
  test("reuses a matching prepared session and claim takes it from the cache", async () => {
    preparedCache[scope] = prepared
    const removed: PreparedRuntimeSession[] = []
    const store = storeFor({
      remove: async (item) => removed.push(item),
    })

    await expect(store.prepare(scope, { directory: "/repo" })).resolves.toEqual(prepared)
    await expect(store.claim(scope, { directory: "/repo" })).resolves.toEqual({ id: "ses_prepared" })
    expect(preparedCache[scope]).toBeUndefined()
    expect(seq[scope]).toBe(1)
    expect(removed).toEqual([])
  })

  test("takes and deletes stale prepared sessions before creating the replacement", async () => {
    preparedCache[scope] = prepared
    const removed: PreparedRuntimeSession[] = []
    const store = storeFor({
      state: { harness: "claude-acp", selectedModel: "opus" },
      create: async () => "ses_next",
      remove: async (item) => removed.push(item),
    })

    await expect(store.prepare(scope, { directory: "/repo" })).resolves.toEqual({
      id: "ses_next",
      directory: "/repo",
      harness: "claude-acp",
      model: "opus",
    })
    expect(removed).toEqual([prepared])
    expect(seq[scope]).toBe(1)
    expect(preparedCache[scope]?.id).toBe("ses_next")
  })

  test("coalesces concurrent prepares for the current sequence", async () => {
    let resolveCreate: (value: string) => void = () => {}
    let createCalls = 0
    const store = storeFor({
      create: async () => {
        createCalls++
        return await new Promise<string>((resolve) => {
          resolveCreate = resolve
        })
      },
    })

    const first = store.prepare(scope, { directory: "/repo" })
    const second = store.prepare(scope, { directory: "/repo" })

    expect(createCalls).toBe(1)
    resolveCreate("ses_next")
    await expect(first).resolves.toEqual(preparedSession("ses_next"))
    await expect(second).resolves.toEqual(preparedSession("ses_next"))
  })

  test("deletes late create results after a drop bumps the sequence", async () => {
    let resolveCreate: (value: string) => void = () => {}
    const removed: PreparedRuntimeSession[] = []
    const store = storeFor({
      create: async () =>
        await new Promise<string>((resolve) => {
          resolveCreate = resolve
        }),
      remove: async (item) => removed.push(item),
    })

    const run = store.prepare(scope, { directory: "/repo" })
    await store.drop(scope)
    resolveCreate("ses_late")

    await expect(run).resolves.toBeUndefined()
    expect(preparedCache[scope]).toBeUndefined()
    expect(removed).toEqual([preparedSession("ses_late")])
  })

  test("reports create failure only while the sequence is current", async () => {
    const errors: unknown[] = []
    const current = storeFor({
      create: async () => {
        throw new Error("boom")
      },
      setPrepareError: (_scope, err) => errors.push(err),
    })
    await expect(current.prepare(scope, { directory: "/repo" })).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)

    let rejectCreate: (err: Error) => void = () => {}
    const stale = storeFor({
      create: async () =>
        await new Promise<string>((_resolve, reject) => {
          rejectCreate = reject
        }),
      setPrepareError: (_scope, err) => errors.push(err),
    })
    const run = stale.prepare(scope, { directory: "/repo" })
    await stale.drop(scope)
    rejectCreate(new Error("late boom"))

    await expect(run).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  test("stays out of direct query-client ownership", async () => {
    const source = await Bun.file(new URL("./harness-prepared-runtime-session.ts", import.meta.url)).text()

    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("setQueryData")
    expect(source).not.toContain("@tanstack")
  })
})

function storeFor(input: {
  state?: { harness: HarnessType; selectedModel?: string }
  create?: (params: { directory: string; harness: HarnessType }) => Promise<string | undefined>
  remove?: (item: PreparedRuntimeSession) => Promise<void>
  setPrepareError?: (scope: string, err: unknown) => void
} = {}) {
  return createPreparedRuntimeSessionStore<{ directory?: string }>({
    canUseRuntimeSession: (params) => !!params?.directory,
    state: () => input.state ?? { harness: "claude-acp", selectedModel: "sonnet" },
    create: (params) => input.create?.(params) ?? Promise.resolve("ses_created"),
    remove: (item) => input.remove?.(item) ?? Promise.resolve(),
    setPrepareError: (scope, err) => input.setPrepareError?.(scope, err),
    cache: fakeCache(),
  })
}

function fakeCache(): PreparedRuntimeSessionCache {
  return {
    getSeq: (scope) => seq[scope],
    setSeq: (scope, value) => {
      seq[scope] = value
    },
    getPrepared: (scope) => preparedCache[scope],
    setPrepared: (scope, value) => {
      preparedCache[scope] = value
    },
    removePrepared: (scope) => {
      delete preparedCache[scope]
    },
    getPreparing: (scope) => pending[scope],
    setPreparing: (scope, value) => {
      pending[scope] = value
    },
    removePreparing: (scope) => {
      delete pending[scope]
    },
  }
}

function preparedSession(id: string): PreparedRuntimeSession {
  return {
    id,
    directory: "/repo",
    harness: "claude-acp",
    model: "sonnet",
  }
}
