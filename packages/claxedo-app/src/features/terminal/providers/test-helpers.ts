/**
 * Shared test infrastructure for terminal tests.
 *
 * Provides a mock SDK, in-memory storage, and a fetch interceptor that
 * mimics the claxedo server's /api/wr/pty endpoints.
 */

type Listener = (event: any) => void

export function createMockSDK() {
  const listeners = new Map<string, Set<Listener>>()
  const serverPtys = new Map<string, { id: string; title: string; cwd: string }>()
  const createCalls: any[] = []

  function emit(type: string, properties: any) {
    const fns = listeners.get(type)
    if (!fns) return
    for (const fn of fns) fn({ type, properties })
  }

  const sdk = {
    url: "http://localhost:7860",
    directory: "/workspace",
    workspace: () => undefined,
    event: {
      on(type: string, fn: Listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
        return () => listeners.get(type)?.delete(fn)
      },
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
