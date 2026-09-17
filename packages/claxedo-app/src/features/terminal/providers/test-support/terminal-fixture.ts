/**
 * Shared test infrastructure for terminal tests.
 *
 * Provides a mock SDK, in-memory storage, a fetch interceptor that
 * mimics the claxedo server's /api/wr/pty endpoints, and the shared
 * `@/platform/api/api` stand-in every terminal suite registers.
 */

import { createMockApi, type ApiModuleShape } from "@/architecture/test-support/mock-api"

type Listener = (event: any) => void

/**
 * Nothing in the terminal suites should reach the JSON client: they drive the
 * transport through `globalThis.fetch` and assert on the requests it sees.
 * The fixture's default client would route through the passthrough `authFetch`
 * below and quietly make a real request, so fail loudly instead.
 */
function unusedApiClient(url: string): never {
  throw new Error(`terminal test: unexpected api client call for ${url}`)
}

/**
 * The `@/platform/api/api` module the terminal suites run against.
 *
 * `mock.module` replaces a module PROCESS-WIDE, so a hand-listed partial mock
 * breaks every importer of an export it forgot — omitting `isLoopbackHttpUrl`
 * (which `platform/runtime/server-transport.ts` imports) is what stopped
 * `relay-lifecycle.test.ts` from loading at all. Building on `createMockApi`,
 * the one shared mirror of api.ts's surface, means there is no list to forget
 * from, and one place to update when that surface changes.
 *
 * Usage: `mock.module("@/platform/api/api", () => createTerminalApiModule(url))`
 */
export function createTerminalApiModule(baseUrl: string): ApiModuleShape {
  return createMockApi({
    // Read `fetch` at call time: the suites install their interceptor by
    // swapping `globalThis.fetch` after this module is registered.
    authFetch: (input, init) => fetch(input, init),
    getClaxedoServerUrl: () => baseUrl,
    getDefaultBaseUrl: () => baseUrl,
    // These suites pin the default base rather than a configured one.
    getConfiguredClaxedoServerUrl: () => "",
    api: {
      get: unusedApiClient,
      post: unusedApiClient,
      put: unusedApiClient,
      patch: unusedApiClient,
      delete: unusedApiClient,
    },
  }).module
}

export function createMockSDK() {
  const listeners = new Map<string, Set<Listener>>()
  const serverPtys = new Map<string, { id: string; title: string; cwd: string }>()
  const createCalls: any[] = []

  // The events emitter's shape: a flat `ClaxedoEvent` per `on(type)` handler.
  function emit(type: string, properties: any) {
    const fns = listeners.get(type)
    if (!fns) return
    for (const fn of fns) fn({ type, ...properties })
  }

  const sdk = {
    url: "http://localhost:7860",
    directory: "/workspace",
    workspace: () => undefined,
    claxedoEvents: {
      on(type: string, fn: Listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
        return () => listeners.get(type)?.delete(fn)
      },
      listen: () => () => undefined,
      connected: () => true,
      centralConnected: () => true,
      controlPlaneReconnects: () => 0,
      workspaceConnected: () => true,
      workspaceReconnects: () => 0,
    },
    client: {
      pty: {
        async create(input: { title?: string; env?: Record<string, string>; previousPtyId?: string }) {
          createCalls.push(input)
          const id = `pty-${sdk._nextId++}`
          const info = { id, title: input.title ?? `Terminal ${id}`, cwd: "/workspace" }
          serverPtys.set(id, info)
          emit("pty.created", { info })
          return { data: info }
        },
        async remove(input: { ptyID: string }) {
          const existed = serverPtys.delete(input.ptyID)
          if (existed) emit("pty.deleted", { id: input.ptyID })
        },
        async update(_input: any) {},
        async list() {
          return { data: Array.from(serverPtys.values()) }
        },
      },
    },
    _emit: emit,
    _serverPtys: serverPtys,
    _listeners: listeners,
    _createCalls: createCalls,
    _nextId: 1,
  }

  return sdk
}

export function createMockStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem(key: string) { return data.get(key) ?? null },
    setItem(key: string, value: string) { data.set(key, value) },
    removeItem(key: string) { data.delete(key) },
    clear() { data.clear() },
  }
}

/**
 * Intercept fetch calls to /api/wr/pty.
 * Mimics the claxedo server response shape and emits SSE events via sdk._emit.
 * Returns a cleanup function that restores the original fetch.
 */
export function installFetchMock(sdk: ReturnType<typeof createMockSDK>) {
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    if (u.includes("/api/wr/pty")) {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}")
        const id = `pty-${sdk._nextId++}`
        const info = { id, title: body.title ?? `Terminal ${id}`, cwd: body.cwd ?? "/workspace" }
        sdk._serverPtys.set(id, info)
        sdk._createCalls.push({
          title: body.title,
          cwd: body.cwd,
          env: body.env,
          command: body.command,
          args: body.args,
          initialCommand: body.initialCommand,
        })
        sdk._emit("pty.created", { info })
        return new Response(JSON.stringify(info), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (init?.method === "DELETE") {
        const id = u.split("/").pop()!
        const existed = sdk._serverPtys.delete(id)
        if (existed) sdk._emit("pty.deleted", { id })
        return new Response("{}", { status: 200 })
      }
      if (init?.method === "PUT") {
        return new Response("{}", { status: 200 })
      }
    }
    return orig(url, init)
  }) as typeof globalThis.fetch
  return () => { globalThis.fetch = orig }
}
