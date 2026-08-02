import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { realpathSync } from "node:fs"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

const root = path.join(realpathSync(os.tmpdir()), `claxedo-frontend-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`)
const data = path.join(root, "data")
const state = path.join(root, "state")

const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = state

const workspaceRows = new Map<string, Record<string, unknown>>()
const ensureSupervisorSandbox = vi.fn(async (workspaceId: string) => ({ workspaceId, url: "http://runtime.frontend.test" }))
const sandboxEnsure = vi.fn(async (workspaceId: string) => ({
  status: "ready" as const,
  workspaceId,
  sandboxId: "frontend-contract-runtime",
  hostId: "frontend-contract-runtime",
  url: "http://runtime.frontend.test",
  epoch: 1,
  homeRegion: "us-east" as const,
}))
const runtimeFetches: string[] = []

vi.mock("./workspace/supervisor/supervisor", () => ({
  ensureSupervisorSandbox,
  holdSupervisorSandbox: vi.fn(),
  releaseSupervisorSandbox: vi.fn(),
  markSupervisorSandboxUse: vi.fn(),
  touchSupervisorSandbox: vi.fn(),
  getSupervisorSandboxTarget: vi.fn(() => undefined),
  getSandbox: vi.fn(() => undefined),
  discardSupervisorSandbox: vi.fn(async () => {}),
  syncWorkspaceRuntimeAgentExtensions: vi.fn(async () => {}),
  broadcastRuntimeConfig: vi.fn(async () => {}),
  getSupervisorSandboxStatus: vi.fn(() => undefined),
  verifyWorkspaceRuntimeControlToken: vi.fn(() => false),
  listSupervisorSandboxs: vi.fn(() => []),
  configureWorkspaceSupervisor: vi.fn(),
  shutdownWorkspaceSupervisor: vi.fn(async () => {}),
  workspaceSupervisorServerUrl: vi.fn(() => "http://127.0.0.1:3001"),
  createWorkspaceSupervisorSandboxManager: vi.fn(() => ({
    ensure: sandboxEnsure,
    register: vi.fn(),
    heartbeat: vi.fn(),
    target: vi.fn(),
    touch: vi.fn(),
    snapshot: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    release: vi.fn(),
    garbageCollect: vi.fn(),
    list: vi.fn(),
  })),
}))

vi.mock("./workspace/store/store", () => ({
  resolveWorkspace: vi.fn(async (input: { workspaceId?: string; directory?: string }) =>
    workspaceRows.get(input.workspaceId ?? "") ?? workspaceRows.get(input.directory ?? "")),
  resolveWorkspaceByRepo: vi.fn(async () => undefined),
  ensureWorkspace: vi.fn(async (input: { workspaceId?: string; directory?: string; kind?: string }) => {
    const row = {
      id: input.workspaceId ?? `ws_${workspaceRows.size}`,
      project_id: input.workspaceId ?? `ws_${workspaceRows.size}`,
      workspace_name: "Workspace",
      directory: input.directory ?? "/workspace",
      kind: input.kind ?? "local",
      created_at: 1,
      updated_at: 1,
    }
    workspaceRows.set(row.id, row)
    workspaceRows.set(row.directory, row)
    return row
  }),
  listWorkspaces: vi.fn(async () => [...new Set(workspaceRows.values())]),
  getWorkspace: vi.fn(async (id: string) => workspaceRows.get(id)),
  getProjectWorkspace: vi.fn(async (id: string) => workspaceRows.get(id)),
  getWorkspaceByDirectory: vi.fn(async (directory: string) => workspaceRows.get(directory)),
  workspaceIdFromDirectoryRef: vi.fn((input: string | undefined) => {
    const value = input?.trim()
    return value && /^ws_[A-Za-z0-9_-]+$/.test(value) ? value : undefined
  }),
  bindWorkspace: vi.fn(async () => {}),
  updateWorkspace: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const row = workspaceRows.get(id)
    if (!row) return undefined
    Object.assign(row, patch)
    return row
  }),
  deleteWorkspace: vi.fn(async (id: string) => workspaceRows.delete(id)),
  deleteWorkspaceByDirectory: vi.fn(async (directory: string) => workspaceRows.delete(directory)),
  listProjects: vi.fn(async () => []),
}))

vi.mock("./opencode/auth", () => ({
  configureOpenCodeAuth: vi.fn(),
  opencodeHeaders: vi.fn((headers?: HeadersInit) => new Headers(headers)),
}))

const [serverMod, servicesMod, syncMod, compatMod, agentConfigMod] = await Promise.all([
  import("./deployments/local/server"),
  import("./control-plane/services"),
  import("./control-plane/adapters/sqlite/central-store"),
  import("./routes/opencode-compat"),
  import("./agent-config"),
])

function seedSyntheticCloudWorkspace() {
  const row = {
    id: "ws_frontend_contract",
    project_id: "ws_frontend_contract",
    workspace_name: "Frontend Contract",
    kind: "cloud",
    provider: "daytona",
    org_id: "org_frontend_contract",
    directory: "/tmp/frontend-contract",
    remote_directory: "/workspace",
    repo_url: "https://github.com/test/repo.git",
    status: "ready",
    created_at: 1,
    updated_at: 1,
  }
  workspaceRows.set(row.id, row)
  workspaceRows.set(row.directory, row)
  return row
}

function createContractApp() {
  const centralStore = syncMod.createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return serverMod.createApp(servicesMod.createControlPlaneServices({
    projectionStore: centralStore.projectionStore,
    durableSessionLog: centralStore.durableSessionLog,
  }, {
    localExecution: { enabled: true },
    telemetry: { capture: () => {} },
    relay: {
      provider: {
        getRelayEndpoint: async () => "http://runtime.frontend.test",
        mintHostTunnelToken: async () => ({ token: "host-token", expiresAt: Date.now() + 60_000, jti: "host-jti" }),
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: Date.now() + 60_000, jti: "runtime-jti" }),
        resolveTarget: async () => undefined,
        drainWorkspace: async () => {},
      },
    },
    sandbox: { sandboxManager: { ensure: sandboxEnsure } as never },
  })).app
}

function expectOk(responses: Record<string, Response>) {
  for (const [name, res] of Object.entries(responses)) {
    expect(res.status, name).toBeGreaterThanOrEqual(200)
    expect(res.status, name).toBeLessThan(300)
  }
}

describe("frontend API contract", () => {
  const originalFetch = globalThis.fetch

  beforeAll(async () => {
    await fs.mkdir(data, { recursive: true })
    await fs.mkdir(state, { recursive: true })
  })

  beforeEach(() => {
    workspaceRows.clear()
    runtimeFetches.length = 0
    ensureSupervisorSandbox.mockClear()
    sandboxEnsure.mockClear()
    compatMod.configureOpenCodeCompat("http://127.0.0.1:1")
    seedSyntheticCloudWorkspace()
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const req = input instanceof Request ? input : new Request(String(input))
      if (!req.url.startsWith("http://runtime.frontend.test")) {
        const url = new URL(req.url)
        if (url.pathname === "/provider") {
          return Response.json({
            all: [{
              id: "opencode",
              name: "OpenCode",
              models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
            }],
            connected: ["opencode"],
            default: { opencode: "big-pickle" },
          })
        }
        if (url.pathname === "/provider/auth") return Response.json({})
        if (url.pathname === "/config/providers") return Response.json({ providers: [], default: {} })
        if (url.pathname === "/global/config") return Response.json({ model: "", provider: {}, mcp: {} })
        return Response.json({}, { status: 404 })
      }
      runtimeFetches.push(req.url)
      const url = new URL(req.url)
      const runtimePath = url.pathname.replace(/^\/workspaces\/[^/]+/, "")
      if (runtimePath === "/provider") {
        return Response.json({
          all: [{
            id: "opencode",
            name: "OpenCode",
            models: {
              "big-pickle": {
                id: "big-pickle",
                name: "Big Pickle",
              },
            },
          }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        })
      }
      if (runtimePath === "/session") return Response.json([])
      if (runtimePath === "/file/status") return Response.json([])
      if (runtimePath === "/command") return Response.json([])
      if (runtimePath === "/agent") return Response.json([])
      if (runtimePath === "/api/wr/harness-config-options" && url.searchParams.get("harness") === "codex-acp") {
        return Response.json({
          error: {
            message: "ACP connection closed: Error: error loading config: ~/.codex/config.toml:7:16: unknown variant `default`, expected `fast` or `flex`",
          },
        }, { status: 502 })
      }
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
    if (previous.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
    else process.env.CLAXEDO_STATE_DIR = previous.CLAXEDO_STATE_DIR
    await fs.rm(root, { recursive: true, force: true })
  })

  test("serves the full frontend boot and prompt-selector API set for a cloud workspace id", async () => {
    const app = createContractApp()
    const workspaceQuery = `directory=${encodeURIComponent("/workspace")}&workspaceId=${encodeURIComponent("ws_frontend_contract")}`
    const responses = {
      health: await app.request("/api/claxedo/health"),
      globalHealth: await app.request("/global/health"),
      bootstrap: await app.request("/api/claxedo/bootstrap?runner=opencode"),
      config: await app.request("/config"),
      globalConfig: await app.request("/global/config"),
      providerAuth: await app.request("/provider/auth?runner=opencode"),
      configProviders: await app.request("/config/providers"),
      workspaceResolve: await app.request(`/api/workspace/resolve?${workspaceQuery}`),
      path: await app.request(`/path?${workspaceQuery}`),
      provider: await app.request(`/provider?${workspaceQuery}&runner=opencode`),
      sessions: await app.request(`/session?${workspaceQuery}&roots=true&limit=55`),
      fileStatus: await app.request(`/file/status?${workspaceQuery}`),
      commands: await app.request(`/command?${workspaceQuery}`),
      agentProfiles: await app.request(`/api/claxedo/agent-config/agents?${workspaceQuery}&type=opencode`),
      runnerOptions: await app.request(`/api/claxedo/agent-config/runner/options?${workspaceQuery}&type=opencode`),
      slashCommands: await app.request(`/api/claxedo/agent-config/commands?${workspaceQuery}`),
    }

    const { runnerOptions, ...okResponses } = responses
    expectOk(okResponses)

    await expect(responses.bootstrap.json()).resolves.toMatchObject({
      provider: {
        connected: ["opencode"],
        default: { opencode: "big-pickle" },
      },
    })
    await expect(responses.config.json()).resolves.toMatchObject({ provider: {}, mcp: {} })
    await expect(responses.globalConfig.json()).resolves.toMatchObject({ provider: {}, mcp: {} })
    await expect(responses.providerAuth.json()).resolves.toMatchObject({
      "claude-acp": [expect.objectContaining({ type: "api" })],
      "codex-acp": [expect.objectContaining({ type: "oauth" }), expect.objectContaining({ type: "api" })],
    })
    await expect(responses.configProviders.json()).resolves.toEqual({ providers: [], default: {} })
    await expect(responses.workspaceResolve.json()).resolves.toMatchObject({
      workspaceId: "ws_frontend_contract",
      directory: "/workspace",
      kind: "cloud",
    })
    await expect(responses.path.json()).resolves.toMatchObject({
      directory: "/tmp/frontend-contract",
      worktree: "/tmp/frontend-contract",
    })
    await expect(responses.provider.json()).resolves.toMatchObject({
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
    await expect(responses.sessions.json()).resolves.toEqual([])
    await expect(responses.fileStatus.json()).resolves.toEqual([])
    await expect(responses.commands.json()).resolves.toEqual([])
    await expect(responses.agentProfiles.json()).resolves.toEqual([])
    expect(responses.runnerOptions.status).toBe(404)
    await expect(responses.runnerOptions.json()).resolves.toMatchObject({
      error: {
        code: "harness_config_options_unavailable",
      },
    })
    await expect(responses.slashCommands.json()).resolves.toEqual([])

    expect(runtimeFetches.sort()).toEqual([
      "http://runtime.frontend.test/workspaces/ws_frontend_contract/command?directory=%2Fworkspace&workspaceId=ws_frontend_contract",
      "http://runtime.frontend.test/workspaces/ws_frontend_contract/file/status?directory=%2Fworkspace&workspaceId=ws_frontend_contract",
      "http://runtime.frontend.test/workspaces/ws_frontend_contract/session?directory=%2Fworkspace&workspaceId=ws_frontend_contract&roots=true&limit=55",
    ].sort())
  })

  test("maps Codex ACP close from runtime options to startup guidance", async () => {
    const res = await createContractApp().request(
      "/api/claxedo/agent-config/harness/options?workspaceId=ws_frontend_contract&type=codex-acp",
    )

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "harness_config_options_unavailable",
        message: "Codex could not start: error loading config: ~/.codex/config.toml:7:16: unknown variant `default`, expected `fast` or `flex`. Run `codex doctor`, fix the reported Codex config/auth issue, then retry.",
      },
    })
  })

  test("reports Cursor SDK unavailable without explicit SDK auth", async () => {
    await agentConfigMod.saveUserConfig({ mcp: {}, auth: {} })

    const res = await createContractApp().request(
      "/api/claxedo/agent-config/harness/options?workspaceId=ws_frontend_contract&type=cursor-sdk",
    )

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "harness_config_options_unavailable",
        message: "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
      },
    })
  })

  test("serves the stale Cursor SDK catalog fallback when the runtime cannot live-list", async () => {
    await agentConfigMod.saveUserConfig({ mcp: {}, auth: { "cursor-sdk": "cursor-sdk-test-key" } })

    const res = await createContractApp().request(
      "/api/claxedo/agent-config/harness/options?workspaceId=ws_frontend_contract&type=cursor-sdk",
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      source: "catalog",
      stale: true,
      options: [{
        id: "model",
        currentValue: "auto",
      }],
    })
  })
})
