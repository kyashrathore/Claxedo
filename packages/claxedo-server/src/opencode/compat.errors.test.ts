import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `opencode-compat-errors-${randomUUID().slice(0, 8)}`)
const prev = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
}
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("@claxedo/local-server/opencode/compat-routes/index")
const { configureAgentConfig, saveCommand } = await import("@claxedo/server-core/agent-config/index")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/db")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
})

afterAll(async () => {
  // Close the suite's sqlite handle before deleting its data dir: Windows
  // refuses to unlink an open claxedo.db (EBUSY), and lags briefly even after
  // close — the retries absorb that lag.
  configureAgentConfig()
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (prev.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY
  if (prev.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
})

describe("opencode compat error model", () => {
  test("serves central commands from the OpenCode compatibility route", async () => {
    await saveCommand("triage", "Triage $ARGUMENTS")

    const res = await app.request("/command")

    expect(res.status).toBe(200)
    expect(await res.json()).toContainEqual({
      name: "triage",
      content: "Triage $ARGUMENTS",
    })
  })

  test("returns structured provider/auth validation errors", async () => {
    const oauth = await app.request("/provider/anthropic/oauth/start?runner=claude-acp", { method: "POST" })
    expect(oauth.status).toBe(404)
    expect(await oauth.json()).toEqual({
      error: {
        code: "opencode_oauth_unsupported",
        message: "oauth unsupported for ACP runners",
      },
    })

    const auth = await app.request("/auth/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: {} }),
    })
    expect(auth.status).toBe(400)
    expect(await auth.json()).toEqual({
      error: {
        code: "opencode_auth_key_required",
        message: "auth.key is required",
      },
    })
  })

  test("returns structured worktree validation errors", async () => {
    const missingDirectory = await app.request("/experimental/worktree", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missingDirectory.status).toBe(400)
    expect(await missingDirectory.json()).toEqual({
      error: {
        code: "opencode_directory_required",
        message: "directory is required",
      },
    })

    const missingWorkspace = await app.request("/experimental/worktree?workspaceId=missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missingWorkspace.status).toBe(404)
    expect(await missingWorkspace.json()).toEqual({
      error: {
        code: "opencode_workspace_not_found",
        message: "Workspace not found",
      },
    })
  })

  test("uses injected env for ACP provider status instead of ambient process env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient-should-not-count"
    await fs.mkdir(root, { recursive: true })

    const emptyEnv = new Hono()
    emptyEnv.route("/", OpenCodeCompatRoutes({ env: {} }))
    const configuredEnv = new Hono()
    configuredEnv.route(
      "/",
      OpenCodeCompatRoutes({
        env: {
          ANTHROPIC_API_KEY: "sk-injected",
          npm_package_version: "9.9.9-test",
        },
      }),
    )

    const empty = await emptyEnv.request("/provider?runner=claude-acp")
    const configured = await configuredEnv.request("/provider?runner=claude-acp")
    const health = await configuredEnv.request("/global/health")

    expect(empty.status).toBe(200)
    expect(configured.status).toBe(200)
    expect(await health.json()).toMatchObject({ version: "9.9.9-test" })

    const emptyBody = await empty.json()
    const configuredBody = await configured.json()

    expect(emptyBody.connected).not.toContain("claude-acp")
    expect(emptyBody.all.find((item: { id: string }) => item.id === "claude-acp")?.source).toBe("config")
    expect(configuredBody.connected).toContain("claude-acp")
    expect(configuredBody.all.find((item: { id: string }) => item.id === "claude-acp")?.source).toBe("env")
  })

  test("serves the Pi catalog under a harness-qualified provider route", async () => {
    const pi = new Hono()
    pi.route("/", OpenCodeCompatRoutes({ env: {} }))

    const res = await pi.request("/provider?harness=pi")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toEqual([])
    expect(body.all.map((provider: { id: string }) => provider.id).sort()).toEqual(
      ["anthropic", "openai", "openai-codex"].sort(),
    )
    expect(
      Object.keys(body.all.find((provider: { id: string }) => provider.id === "anthropic").models).length,
    ).toBeGreaterThan(0)
  })

  test("agent list uses SandboxManager when composed", async () => {
    await ensureWorkspace({
      workspaceId: "ws_agent",
      org_id: "org_1",
      directory: "/workspace",
      kind: "cloud",
      remote_directory: "/remote/workspace",
      status: "ready",
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_agent",
        sandboxId: "sb_agent",
        hostId: "host_agent",
        url: "https://runtime-manager.test",
        epoch: 1,
        homeRegion: "eu-west" as const,
      })),
    }
    const relayProvider = {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token", expiresAt: 123, jti: "jti_1" })),
      getRelayEndpoint: vi.fn(async () => "https://relay.example.test"),
    }
    globalThis.fetch = vi.fn(async () => Response.json([{ name: "runtime-agent" }])) as never
    const composed = new Hono()
    composed.route(
      "/",
      OpenCodeCompatRoutes({
        services: {
          sandbox: { sandboxManager },
          relay: { provider: relayProvider },
          defaultHomeRegion: "eu-west",
        } as never,
      }),
    )

    const res = await composed.request("/agent?workspaceId=ws_agent")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual([{ name: "runtime-agent" }])
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_agent", { homeRegion: "eu-west" })
    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_agent",
        hostId: "host_agent",
      }),
    )
    expect(String((globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(
      "https://relay.example.test/workspaces/ws_agent/agent",
    )
  })
})
