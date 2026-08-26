import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createMockSDK, createMockStorage } from "./test-helpers"

const storage = createMockStorage()
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?relay-lifecycle-restore`)) }
const realPersistModule = {
  ...(await import(`${import.meta.dir}/../../../platform/persistence/persist.ts?relay-lifecycle-restore`)),
}
const realRecoveryModule = {
  ...(await import(`${import.meta.dir}/../core/terminal-recovery.ts?relay-lifecycle-restore`)),
}

afterAll(() => {
  mock.module("@/platform/api/api", () => realApiModule)
  mock.module("@/platform/persistence/persist", () => realPersistModule)
  mock.module("@/features/terminal/core/terminal-recovery", () => realRecoveryModule)
})

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: () => ({ use: () => {}, provider: () => {} }),
}))

mock.module("@/app/providers/sdk/sdk", () => ({
  useSDK: () => {
    throw new Error("useSDK called outside test")
  },
}))

mock.module("@/platform/api/api", () => ({
  authFetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  getConfiguredClaxedoServerUrl: () => "",
  getDefaultBaseUrl: () => "http://server.test",
  getClaxedoServerUrl: () => "http://server.test",
  isDemoMode: () => false,
  // Stub remaining api.ts exports so other tests in the same suite
  // run that transitively import this module don't crash with
  // "Export named 'api' not found" — bun:test mock.module shims leak
  // across files.
  api: {} as Record<string, unknown>,
  isDemoPath: () => false,
  isEmbedMode: () => false,
  fixDir: (input: string | undefined) => input,
  configureApiRuntime: () => undefined,
  resetApiRuntime: () => undefined,
  apiBearerToken: async () => null,
  normalizeUrl: (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined,
}))

// Spread the real module: `mock.module` replaces the module PROCESS-WIDE, so a
// partial mock would break later files that import its other exports.
mock.module("@/platform/persistence/persist", () => ({
  ...realPersistModule,
  Persist: {
    ...realPersistModule.Persist,
    scoped: (_dir: string, _session: string | undefined, key: string) => ({
      storage: "test.dat",
      key: `workspace:${key}`,
    }),
    serverWorkspace: (_url: string, _dir: string, key: string) => ({
      storage: "test.dat",
      key: `workspace:${key}`,
    }),
  },
  persisted: (_target: any, storeResult: any) => {
    const [state, setState] = storeResult
    const key = typeof _target === "string" ? _target : _target.key
    const raw = storage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      setState("all", parsed.all ?? [])
      if (parsed.active !== undefined) setState("active", parsed.active)
    }
    const persistingSet = (...args: any[]) => {
      setState(...args)
      storage.setItem(
        key,
        JSON.stringify(
          JSON.parse(
            JSON.stringify({
              all: state.all,
              active: state.active,
            }),
          ),
        ),
      )
    }
    return [state, persistingSet, null, () => true]
  },
  removePersisted: (target: { key: string }) => {
    storage.removeItem(target.key)
    return Promise.resolve()
  },
}))

// Spread the real module for the same reason as persist above: a PARTIAL mock
// leaves every other export bound to whatever the previously-registered mock
// happened to install, and the no-op `clearInitialCommandMarker` then leaks
// into terminal-recovery.test.ts (which runs later in CI's file order) and
// silently breaks its `executed`-set clearing.
mock.module("@/features/terminal/core/terminal-recovery", () => ({
  ...realRecoveryModule,
  clearInitialCommandMarker: () => {},
}))

const { createTerminalSession } = await import("@/features/terminal/providers/provider")

function requestFrom(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  return input instanceof Request ? input : new Request(input, init)
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = item
  }
  return result
}

function jsonBody(init?: RequestInit) {
  if (typeof init?.body !== "string") return undefined
  return record(JSON.parse(init.body))
}

function token(jti: string) {
  return [
    btoa(JSON.stringify({ alg: "none" })),
    btoa(JSON.stringify({ jti })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    "sig",
  ].join(".")
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function createSession(input: {
  request: typeof fetch
  claxedoServerUrl?: string
  workspaceId?: string
  directory?: string
  sdkWorkspace?: { workspaceId: string; kind: "cloud" | "local" | "user-hosted"; directory?: string }
  resolveWorkspaceRuntime?: (input: {
    directory: string
    workspaceId?: string
  }) => Promise<{ kind: "cloud" | "local" | "user-hosted"; workspaceId?: string } | null>
}) {
  const sdk = createMockSDK()
  if (input.directory) sdk.directory = input.directory
  if (input.sdkWorkspace) sdk.workspace = () => input.sdkWorkspace
  const workspaceId = input.workspaceId ?? "ws_1"
  let session: ReturnType<typeof createTerminalSession>
  let dispose: () => void
  createRoot((d) => {
    dispose = d
    session = createTerminalSession(sdk, input.directory ?? "/workspace", {
      claxedoServerUrl: input.claxedoServerUrl ?? "http://server.test",
      request: input.request,
      resolveWorkspaceRuntime:
        input.resolveWorkspaceRuntime ??
        (async () => ({
          kind: "cloud",
          workspaceId,
        })),
    })
  })
  return { session: session!, dispose: dispose! }
}

describe("terminal relay lifecycle", () => {
  beforeEach(() => {
    storage.clear()
  })

  test("starts agent terminal commands as the PTY process instead of typed input", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const request: typeof fetch = async (input, init) => {
      const req = requestFrom(input, init)
      calls.push({
        url: req.url,
        method: req.method,
        body: jsonBody(init),
      })

      if (req.url === "http://server.test/api/workspace/ws_1/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: token("rat_1"),
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/pty" && req.method === "POST") {
        return Response.json({
          id: "pty_1",
          title: "Claude",
          cwd: "/workspace",
        })
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }

    const { session, dispose } = createSession({ request })
    const ptyId = await session.new(
      `"/Users/yashvardhansingh/.claxedo/bin/claude" --dangerously-skip-permissions`,
      "Claude",
    )

    expect(ptyId).toBe("pty_1")
    const create = calls.find((call) => call.method === "POST")
    expect(create?.body?.command).toBe("/Users/yashvardhansingh/.claxedo/bin/claude")
    expect(create?.body?.args).toEqual(["--dangerously-skip-permissions"])
    expect(create?.body?.initialCommand).toBeUndefined()

    dispose()
  })

  test("sends no cwd when a Windows terminal starts at the workspace root", async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const request: typeof fetch = async (_input, init) => {
      calls.push(jsonBody(init))
      return Response.json({ id: "pty_windows", title: "Terminal", cwd: "C:\\repo" })
    }
    const { session, dispose } = createSession({
      request,
      directory: "C:\\repo",
      resolveWorkspaceRuntime: async () => ({ kind: "local" }),
    })

    expect(await session.new()).toBe("pty_windows")
    expect(calls[0]?.cwd).toBeUndefined()

    dispose()
  })

  test("sends a relative cwd for a Windows terminal below the workspace root", async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const request: typeof fetch = async (_input, init) => {
      calls.push(jsonBody(init))
      return Response.json({ id: "pty_windows_child", title: "Terminal", cwd: "C:\\repo\\packages\\app" })
    }
    const sdkDirectory = "C:\\REPO\\packages\\app"
    // The route scope owns the workspace root while the SDK may point at a
    // child directory with Windows' case-insensitive drive/path spelling.
    const sdk = createMockSDK()
    sdk.directory = sdkDirectory
    let childSession: ReturnType<typeof createTerminalSession>
    let disposeChild: () => void
    createRoot((d) => {
      disposeChild = d
      childSession = createTerminalSession(sdk, "C:\\repo", {
        claxedoServerUrl: "http://server.test",
        request,
        resolveWorkspaceRuntime: async () => ({ kind: "local" }),
      })
    })

    expect(await childSession!.new()).toBe("pty_windows_child")
    expect(calls.at(-1)?.cwd).toBe("packages/app")

    disposeChild!()
  })

  test("routes cloud PTY create, update, clone, and delete through Workspace Relay", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body?: Record<string, unknown> }> =
      []
    let nextPty = 1
    const request: typeof fetch = async (input, init) => {
      const req = requestFrom(input, init)
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("Authorization"),
        body: jsonBody(init),
      })

      if (req.url.startsWith("http://server.test/api/wr/pty")) {
        throw new Error(`Unexpected claxedo-server PTY proxy request: ${req.method} ${req.url}`)
      }

      if (req.url === "http://server.test/api/workspace/ws_lifecycle/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_lifecycle",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: token("rat_1"),
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty" && req.method === "POST") {
        return Response.json({
          id: `pty_${nextPty++}`,
          title: "Terminal",
          cwd: "/workspace",
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty/pty_1" && req.method === "PUT") {
        return Response.json({
          id: "pty_1",
          title: "Renamed",
          cwd: "/workspace",
        })
      }

      if (
        req.url === "https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty/pty_2" &&
        req.method === "DELETE"
      ) {
        return Response.json(true)
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }

    const { session, dispose } = createSession({ request, workspaceId: "ws_lifecycle" })

    const ptyId = await session.new("echo ok", "Terminal")
    expect(ptyId).toBe("pty_1")

    session.update({ id: "pty_1", title: "Renamed", cols: 100, rows: 30 })
    await tick()

    const cloneId = await session.clone("pty_1")
    expect(cloneId).toBe("pty_2")

    await session.close("pty_2")

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://server.test/api/workspace/ws_lifecycle/connection",
      "POST https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty",
      "PUT https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty/pty_1",
      "POST https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty",
      "DELETE https://relay.example.test/workspaces/ws_lifecycle/api/wr/pty/pty_2",
    ])
    expect(calls[1].body.initialCommand).toBe("echo ok")
    expect(calls.slice(1).every((call) => call.authorization === `Bearer ${token("rat_1")}`)).toBe(true)

    dispose()
  })

  test("routes self-hosted filesystem directory PTY through scoped workspace identity", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const request: typeof fetch = async (input, init) => {
      const req = requestFrom(input, init)
      calls.push({
        url: req.url,
        method: req.method,
        body: jsonBody(init),
      })

      if (req.url.includes("/api/workspace/resolve")) {
        throw new Error(`Unexpected directory resolve: ${req.method} ${req.url}`)
      }

      if (req.url.startsWith("http://server.test/api/wr/pty")) {
        throw new Error(`Unexpected control-plane PTY request: ${req.method} ${req.url}`)
      }

      if (req.url === "http://server.test/api/workspace/ws_selfhost/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          runtimeKind: "user-hosted",
          workspaceId: "ws_selfhost",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: token("rat_selfhost"),
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_selfhost/api/wr/pty" && req.method === "POST") {
        return Response.json({
          id: "pty_selfhost",
          title: "Terminal",
          cwd: "/tmp/claxedo-portability/ws_cleantest1-dir",
        })
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }

    const { session, dispose } = createSession({
      request,
      workspaceId: "ws_selfhost",
      directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      sdkWorkspace: {
        workspaceId: "ws_selfhost",
        kind: "user-hosted",
        directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
      },
      resolveWorkspaceRuntime: async () => null,
    })

    const ptyId = await session.new("echo ok", "Terminal")
    expect(ptyId).toBe("pty_selfhost")
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://server.test/api/workspace/ws_selfhost/connection",
      "POST https://relay.example.test/workspaces/ws_selfhost/api/wr/pty",
    ])

    dispose()
  })

  test("routes loopback cloud PTY lifecycle through the local workspace proxy", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const request: typeof fetch = async (input, init) => {
      const req = requestFrom(input, init)
      calls.push({ url: req.url, method: req.method })
      if (req.url === "http://127.0.0.1:3001/workspaces/ws_loopback/api/wr/pty" && req.method === "POST") {
        return Response.json({ id: "pty_1", title: "Terminal", cwd: "/workspace" })
      }
      if (req.url === "http://127.0.0.1:3001/workspaces/ws_loopback/api/wr/pty/pty_1" && req.method === "PUT") {
        return Response.json({ id: "pty_1", title: "Renamed", cwd: "/workspace" })
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = request
    const { session, dispose } = createSession({
      request,
      claxedoServerUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_loopback",
    })

    try {
      const ptyId = await session.new("echo ok", "Terminal")
      expect(ptyId).toBe("pty_1")

      session.update({ id: "pty_1", title: "Renamed", cols: 100, rows: 30 })
      await tick()

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "POST http://127.0.0.1:3001/workspaces/ws_loopback/api/wr/pty",
        "PUT http://127.0.0.1:3001/workspaces/ws_loopback/api/wr/pty/pty_1",
      ])
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
  })

  test("keeps local workspace identity on the direct PTY API", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    let nextPty = 1
    const request: typeof fetch = async (input, init) => {
      const req = requestFrom(input, init)
      calls.push({
        url: req.url,
        method: req.method,
        body: jsonBody(init),
      })
      if (req.url.startsWith("http://127.0.0.1:3001/workspaces/")) {
        throw new Error(`Unexpected workspace PTY proxy request: ${req.method} ${req.url}`)
      }
      if (req.url.startsWith("http://127.0.0.1:3001/api/wr/pty") && req.method === "POST") {
        return Response.json({ id: `pty_${nextPty++}`, title: "Terminal", cwd: "/Users/yash/project" })
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }

    const { session, dispose } = createSession({
      request,
      claxedoServerUrl: "http://127.0.0.1:3001",
      directory: "/Users/yash/project",
      sdkWorkspace: {
        workspaceId: "ws_local_identity",
        kind: "local",
        directory: "/Users/yash/project",
      },
      resolveWorkspaceRuntime: async () => null,
    })

    const ptyId = await session.new("echo ok", "Terminal")
    expect(ptyId).toBe("pty_1")

    session.update({ id: "pty_1", cwd: "/Users/yash/project/subdir" })
    await tick()

    const cloneId = await session.clone("pty_1")
    expect(cloneId).toBe("pty_2")

    expect(
      calls.map((call) => {
        const url = new URL(call.url)
        return `${call.method} ${url.pathname}?directory=${url.searchParams.get("directory") ?? ""}`
      }),
    ).toEqual([
      "POST /api/wr/pty?directory=/Users/yash/project",
      "PUT /api/wr/pty/pty_1?directory=/Users/yash/project",
      "POST /api/wr/pty?directory=/Users/yash/project",
    ])
    expect(calls[2].body?.cwd).toBe("subdir")
    expect(calls[2].body?.env).toMatchObject({
      CLAXEDO_WORKSPACE_ID: "ws_local_identity",
      previousPtyId: "pty_1",
    })

    dispose()
  })
})
