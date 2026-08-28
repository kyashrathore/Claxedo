import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = {
  ensureSupervisorSandbox: vi.fn(),
  holdSupervisorSandbox: vi.fn(),
  markSupervisorSandboxUse: vi.fn(),
  touchSupervisorSandbox: vi.fn(),
  releaseSupervisorSandbox: vi.fn(),
  getSupervisorSandboxTarget: vi.fn(() => undefined),
  getSandbox: vi.fn(),
  broadcastRuntimeConfig: vi.fn(async () => {}),
  syncWorkspaceRuntimeAgentExtensions: vi.fn(async () => {}),
  discardSupervisorSandbox: vi.fn(async () => {}),
  getSupervisorSandboxStatus: vi.fn(() => undefined),
  verifyWorkspaceRuntimeControlToken: vi.fn(() => false),
  configureWorkspaceSupervisor: vi.fn(),
  shutdownWorkspaceSupervisor: vi.fn(async () => {}),
  workspaceSupervisorServerUrl: vi.fn(() => "http://127.0.0.1:3001"),
  listSupervisorSandboxs: vi.fn(() => []),
  workspaceRows: new Map<string, Record<string, unknown>>(),
  resolveWorkspace: vi.fn(async (input: { workspaceId?: string; directory?: string }) =>
    mocks.workspaceRows.get(input.workspaceId ?? "") ?? mocks.workspaceRows.get(input.directory ?? "")),
  opencodeHeaders: vi.fn((headers?: HeadersInit) => new Headers(headers)),
}

vi.mock("../../workspace/supervisor", () => ({
  ensureSupervisorSandbox: mocks.ensureSupervisorSandbox,
  holdSupervisorSandbox: mocks.holdSupervisorSandbox,
  markSupervisorSandboxUse: mocks.markSupervisorSandboxUse,
  touchSupervisorSandbox: mocks.touchSupervisorSandbox,
  releaseSupervisorSandbox: mocks.releaseSupervisorSandbox,
  getSupervisorSandboxTarget: mocks.getSupervisorSandboxTarget,
  getSandbox: mocks.getSandbox,
  broadcastRuntimeConfig: mocks.broadcastRuntimeConfig,
  syncWorkspaceRuntimeAgentExtensions: mocks.syncWorkspaceRuntimeAgentExtensions,
  discardSupervisorSandbox: mocks.discardSupervisorSandbox,
  getSupervisorSandboxStatus: mocks.getSupervisorSandboxStatus,
  verifyWorkspaceRuntimeControlToken: mocks.verifyWorkspaceRuntimeControlToken,
  configureWorkspaceSupervisor: mocks.configureWorkspaceSupervisor,
  shutdownWorkspaceSupervisor: mocks.shutdownWorkspaceSupervisor,
  workspaceSupervisorServerUrl: mocks.workspaceSupervisorServerUrl,
  listSupervisorSandboxs: mocks.listSupervisorSandboxs,
}))

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
  ensureWorkspace: vi.fn(async (input: { workspaceId?: string; directory?: string; kind?: string; repo_url?: string; status?: string }) => {
    const row = {
      id: input.workspaceId ?? crypto.randomUUID(),
      project_id: input.workspaceId ?? crypto.randomUUID(),
      workspace_name: input.directory?.split("/").filter(Boolean).at(-1) ?? "workspace",
      directory: input.directory ?? "/workspace",
      kind: input.kind ?? "local",
      repo_url: input.repo_url,
      status: input.status,
      created_at: 1,
      updated_at: 1,
    }
    mocks.workspaceRows.set(row.id, row)
    mocks.workspaceRows.set(row.directory, row)
    return row
  }),
  listWorkspaces: vi.fn(async () => [...new Set(mocks.workspaceRows.values())]),
  getWorkspace: vi.fn(async (id: string) => mocks.workspaceRows.get(id)),
  getProjectWorkspace: vi.fn(async (id: string) => mocks.workspaceRows.get(id)),
  getWorkspaceByDirectory: vi.fn(async (directory: string) => mocks.workspaceRows.get(directory)),
  bindWorkspace: vi.fn(async () => {}),
  updateWorkspace: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const row = mocks.workspaceRows.get(id)
    if (!row) return undefined
    Object.assign(row, patch)
    return row
  }),
  deleteWorkspace: vi.fn(async (id: string) => mocks.workspaceRows.delete(id)),
  deleteWorkspaceByDirectory: vi.fn(async (directory: string) => mocks.workspaceRows.delete(directory)),
  listProjects: vi.fn(async () => []),
}))

vi.mock("@claxedo/server-core/opencode/auth", () => ({
  configureOpenCodeAuth: vi.fn(),
  opencodeHeaders: mocks.opencodeHeaders,
}))

const { createWorkspaceRuntimeProxy } = await import("@claxedo/local-server/workspace/runtime-dispatch/middleware")
const { embeddedConfigModeForPath } = await import("@claxedo/local-server/workspace/runtime-dispatch/internals")
const { configureWorkspaceSupervisorPort } = await import("@claxedo/server-core/workspace/supervisor-port")

const {
  markSupervisorSandboxUse,
  getSandbox,
  resolveWorkspace,
} = mocks

function resetWorkspaceStoreMock() {
  mocks.workspaceRows.clear()
  resolveWorkspace.mockReset()
  resolveWorkspace.mockImplementation(async (input: { workspaceId?: string; directory?: string }) =>
    mocks.workspaceRows.get(input.workspaceId ?? "") ?? mocks.workspaceRows.get(input.directory ?? ""))
}

function context(url: string) {
  const raw = new Request(url)
  return {
    req: {
      url,
      method: raw.method,
      raw,
      query(name: string) {
        return new URL(url).searchParams.get(name) ?? undefined
      },
      header(name: string) {
        return raw.headers.get(name) ?? undefined
      },
    },
    json(body: unknown, status: number) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  } as any
}

describe("workspaceRuntimeProxy startup wait", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Dispatch reaches the supervisor through the composed port, which is what
    // keeps the cloud provisioning graph out of the dispatch closure.
    configureWorkspaceSupervisorPort({
      hold: mocks.holdSupervisorSandbox,
      release: mocks.releaseSupervisorSandbox,
      markUse: mocks.markSupervisorSandboxUse,
      touch: mocks.touchSupervisorSandbox,
      broadcastRuntimeConfig: mocks.broadcastRuntimeConfig,
      syncAgentExtensions: mocks.syncWorkspaceRuntimeAgentExtensions,
    })
    resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      remote_directory: "/workspace",
    })
    getSandbox.mockReturnValue(undefined)
  })

  afterEach(() => {
    configureWorkspaceSupervisorPort(undefined)
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    resetWorkspaceStoreMock()
  })

  test("does not fail early while the runtime is still starting", async () => {
    let ready!: (value: {
      status: "ready"
      workspaceId: string
      sandboxId: string
      hostId: string
      url: string
    }) => void
    const sandboxManager = {
      ensure: vi.fn(() => new Promise((resolve) => {
        ready = resolve
      })),
    }
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const resPromise = createWorkspaceRuntimeProxy({ sandboxManager: sandboxManager as any })(
      context("http://localhost/api/wr/health?directory=%2Ftmp%2Fdemo"),
      vi.fn(async () => undefined),
    ) as Promise<Response>

    let settled = false
    void resPromise.finally(() => {
      settled = true
    })

    vi.advanceTimersByTime(5_000)
    await Promise.resolve()
    expect(settled).toBe(false)

    ready({
      status: "ready",
      workspaceId: "ws_1",
      sandboxId: "sb_1",
      hostId: "host_1",
      url: "http://runtime.test",
    })

    const res = await resPromise
    expect(res.status).toBe(200)
    expect(markSupervisorSandboxUse).toHaveBeenCalledWith("ws_1")
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test("returns structured runtime unavailable errors", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => {
        throw new Error("sandbox boot failed")
      }),
    }

    const res = await createWorkspaceRuntimeProxy({ sandboxManager: sandboxManager as any })(
      context("http://localhost/api/wr/health?workspaceId=ws_1&directory=%2Ftmp%2Fdemo"),
      vi.fn(async () => undefined),
    ) as Response

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_runtime_unavailable",
        message: "workspace runtime unavailable",
        detail: "sandbox boot failed",
      },
      workspaceId: "ws_1",
      directory: "/tmp/demo",
    })
  })

  test("routes app-facing workspace runtime routes through the workspace runtime", async () => {
    const next = vi.fn(async () => undefined)
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_frontend_contract",
        sandboxId: "sb_1",
        hostId: "host_1",
        url: "http://runtime.test",
      })),
    }
    const urls = [
      "http://localhost/session?workspaceId=ws_frontend_contract&roots=true&limit=55",
      "http://localhost/mcp?workspaceId=ws_frontend_contract",
      "http://localhost/file/status?workspaceId=ws_frontend_contract",
      "http://localhost/find/file?workspaceId=ws_frontend_contract",
      "http://localhost/api/wr/process?workspaceId=ws_frontend_contract",
      "http://localhost/api/wr/diff/vcs?workspaceId=ws_frontend_contract",
      "http://localhost/api/wr/pty?workspaceId=ws_frontend_contract",
    ]
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const proxy = createWorkspaceRuntimeProxy({ sandboxManager: sandboxManager as any })

    const responses = await Promise.all(urls.map((url) => proxy(context(url), next) as Promise<Response>))

    expect(responses.map((res) => res.status)).toEqual(Array.from({ length: urls.length }, () => 204))
    expect(next).not.toHaveBeenCalled()
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(urls.length)
  })

  test("uses SandboxManager when the product server composes one", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_1",
        sandboxId: "sb_1",
        hostId: "host_1",
        url: "http://manager-runtime.test",
        epoch: 1,
        homeRegion: "us-east" as const,
      })),
      touch: vi.fn(async () => ({ touched: true, status: "ready" as const })),
    }
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const res = await createWorkspaceRuntimeProxy({ sandboxManager: sandboxManager as any })(
      context("http://localhost/api/wr/health?workspaceId=ws_1"),
      vi.fn(async () => undefined),
    ) as Response

    expect(res.status).toBe(200)
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(sandboxManager.touch).toHaveBeenCalledWith("ws_1")
    expect(String((globalThis.fetch as any).mock.calls[0][0].url)).toBe("http://manager-runtime.test/api/wr/health?workspaceId=ws_1")
  })

  test("uses Relay-backed workspace routing when a Relay provider is composed", async () => {
    resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      kind: "cloud",
      directory: "/tmp/demo",
      remote_directory: "/workspace",
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_1",
        sandboxId: "sb_1",
        hostId: "host_1",
        url: "http://manager-runtime.test",
        epoch: 1,
        homeRegion: "eu-west" as const,
      })),
      touch: vi.fn(async () => ({ touched: true, status: "ready" as const })),
    }
    const relayProvider = {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token", expiresAt: 123, jti: "jti_1" })),
      getRelayEndpoint: vi.fn(async () => "https://relay.eu.test"),
    }
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const res = await createWorkspaceRuntimeProxy({
      sandboxManager: sandboxManager as any,
      relayProvider: relayProvider as any,
    })(
      context("http://localhost/file/content?workspaceId=ws_1&directory=%2Flocal"),
      vi.fn(async () => undefined),
    ) as Response

    expect(res.status).toBe(200)
    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      hostId: "host_1",
      subject: "control-plane",
      principalKind: "service",
      actorId: "control-plane",
      actorKind: "agent",
      orgId: "org_1",
      role: "owner",
      ttlMs: 10 * 60_000,
    })
    expect(relayProvider.getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    const req = (globalThis.fetch as any).mock.calls[0][0] as Request
    expect(req.url).toBe("https://relay.eu.test/workspaces/ws_1/file/content?workspaceId=ws_1&directory=%2Flocal")
    expect(req.headers.get("authorization")).toBe("Bearer relay-runtime-token")
    expect(req.headers.get("x-opencode-directory")).toBe("workspace:ws_1")
    expect(req.headers.get("X-Daytona-Skip-Preview-Warning")).toBeNull()
  })
})

describe("embedded workspace runtime config hydration", () => {
  test("does not block passive local sandbox-manager routes on config hydration", () => {
    for (const path of [
      "/api/wr/health",
      "/api/wr/capabilities",
      "/global/event",
      "/event",
      "/api/wr/runtime-events",
      "/file/content",
      "/find/file",
      "/api/wr/pty/abc123/connect",
      "/api/wr/process",
      "/api/wr/diff/vcs",
      "/lsp",
      "/vcs",
    ]) {
      expect(embeddedConfigModeForPath(path)).toBe("skip")
    }
  })

  test("requires config hydration for runner/session/config-owned local routes", () => {
    for (const path of [
      "/session",
      "/session/abc123/message",
      "/permission",
      "/question",
      "/api/wr/config",
      "/api/wr/harness-config-options",
      "/mcp",
      "/agent",
      "/command",
      "/api/wr/hook/agent-lifecycle",
    ]) {
      expect(embeddedConfigModeForPath(path, "POST")).toBe("sync")
    }
  })
})
