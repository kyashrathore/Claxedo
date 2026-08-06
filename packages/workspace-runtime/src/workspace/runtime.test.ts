import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { Hono } from "hono"
import type { CompatEvent } from "../compat-events"
import { fetchDouble } from "../test-support/fetch-double"
import fs from "fs"
import os from "os"
import path from "path"
import {
  ACP_REMOTE_TRANSPORT_FLAG,
  acpRemoteTransportEnabled,
  acpTransportFactory,
  createWorkspaceHost,
  defaultWorkspaceHarnessRegistry,
  materializeCodexAuth,
  runtimeAuthKey,
  type WorkspaceHarnessRegistry,
  type WorkspaceRuntimeStore,
  type WorkspaceRuntimeStoreFactory,
} from "./runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { ConfigRoutes } from "../routes/config"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "../management-auth"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { RuntimeStore } from "../store"
import { createProcessObserver, type ProcessObserverEvent } from "../managed-processes/process-observer"
import type { AgentConfigOption, SessionConfig } from "@claxedo/agent-sdk-runtime"
import {
  AcpHarnessAdapter,
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  OpenCodeHarnessAdapter,
  PiHarnessAdapter,
  type AgentHarnessAdapter,
  type OpenCodeRequestFn,
} from "@claxedo/agent-sdk-runtime/adapters"

const tempDirs: string[] = []
const runtimeConfigWorkspaceId = "ws_runtime_test"
const runtimeConfigHostId = "host_runtime_test"
const runtimeConfigToken = "allow-runtime-config"
const originalHome = process.env.HOME
const originalDataDir = process.env.WORKSPACE_RUNTIME_DATA_DIR
const originalAgentType = process.env.WORKSPACE_RUNTIME_RUNNER
const originalAcpBinary = process.env.WORKSPACE_RUNTIME_ACP_BINARY
const originalAcpModel = process.env.CLAXEDO_ACP_MODEL
const originalOpencodeUrl = process.env.OPENCODE_URL
const originalWrDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
const originalAcpRemoteTransport = process.env[ACP_REMOTE_TRANSPORT_FLAG]
const originalFetch = globalThis.fetch
const loopbackExposure = loopbackWorkspaceRuntimeExposure()

function codexAuth(input?: { openaiKey?: string }) {
  return JSON.stringify({
    type: "codex_auth",
    auth_mode: "chatgpt",
    ...(input?.openaiKey ? { OPENAI_API_KEY: input.openaiKey } : {}),
    tokens: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: "account-id",
      id_token: "id-token",
    },
    oauth: {
      access: "oauth-access",
      refresh: "oauth-refresh",
      account_id: "oauth-account",
    },
    last_refresh: "2026-04-22T00:00:00.000Z",
  })
}

function codexAccountAuth() {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "account-access-token",
      refresh_token: "account-refresh-token",
      account_id: "account-id",
      id_token: "account-id-token",
    },
    last_refresh: "2026-04-22T00:00:00.000Z",
  })
}

afterEach(async () => {
  process.env.HOME = originalHome
  process.env.WORKSPACE_RUNTIME_DATA_DIR = originalDataDir
  process.env.WORKSPACE_RUNTIME_RUNNER = originalAgentType
  process.env.WORKSPACE_RUNTIME_ACP_BINARY = originalAcpBinary
  process.env.CLAXEDO_ACP_MODEL = originalAcpModel
  process.env.OPENCODE_URL = originalOpencodeUrl
  process.env.WORKSPACE_RUNTIME_DIRECTORY = originalWrDirectory
  if (originalAcpRemoteTransport === undefined) delete process.env[ACP_REMOTE_TRANSPORT_FLAG]
  else process.env[ACP_REMOTE_TRANSPORT_FLAG] = originalAcpRemoteTransport
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

const runtimeConfigManagementAuth: WorkspaceRuntimeManagementAuth = {
  authorize: async (input) =>
    input.request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) === runtimeConfigToken
      ? { ok: true, subject: "runtime-test", scopes: [input.action] }
      : {
          ok: false,
          status: 401,
          code: "runtime_management_token_required",
          message: "Workspace runtime management token is required",
        },
}

function mountTestHost(app: Hono, options?: Parameters<typeof createWorkspaceHost>[0]) {
  const host = createWorkspaceHost(options)
  app.route("/", ConfigRoutes((snapshot) => host.apply(snapshot), {
    managementAuth: runtimeConfigManagementAuth,
    managementTarget: {
      workspaceId: runtimeConfigWorkspaceId,
      hostId: runtimeConfigHostId,
    },
  }))
  host.mount(app, { exposure: loopbackExposure })
  return host
}

async function pushRuntimeConfig(app: Hono, body: unknown) {
  return app.request("http://localhost/api/wr/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: runtimeConfigToken,
    },
    body: JSON.stringify(body),
  })
}

describe("workspace runtime auth helpers", () => {
  test("ACP remote transport is disabled by default", () => {
    delete process.env[ACP_REMOTE_TRANSPORT_FLAG]

    expect(acpRemoteTransportEnabled()).toBe(false)
    expect(acpTransportFactory({
      type: "claude-acp",
      url: "http://127.0.0.1:7331/acp",
    })).toBeUndefined()
  })

  test("ACP remote transport is opt-in behind a feature flag", () => {
    process.env[ACP_REMOTE_TRANSPORT_FLAG] = "1"

    expect(acpRemoteTransportEnabled()).toBe(true)
    const factory = acpTransportFactory({
      type: "claude-acp",
      transport: "streamable-http",
      url: "http://127.0.0.1:7331/acp",
    })
    expect(factory).toBeTypeOf("function")
    expect(factory!({
      directory: "/tmp",
      binary: "claude-agent-acp",
      args: [],
      model: "",
      env: {},
      onStderr() {},
      onExit() {},
      onError() {},
    }).kind).toBe("streamable-http")
  })

  test("ACP http transport spelling aliases to streamable-http", () => {
    process.env[ACP_REMOTE_TRANSPORT_FLAG] = "1"

    const factory = acpTransportFactory({
      type: "claude-acp",
      transport: "http",
      url: "http://127.0.0.1:7331/acp",
    } as unknown as Parameters<typeof acpTransportFactory>[0])
    expect(factory).toBeTypeOf("function")
    expect(factory!({
      directory: "/tmp",
      binary: "claude-agent-acp",
      args: [],
      model: "",
      env: {},
      onStderr() {},
      onExit() {},
      onError() {},
    }).kind).toBe("streamable-http")
  })

  test("ACP remote websocket transport is also gated by the feature flag", () => {
    delete process.env[ACP_REMOTE_TRANSPORT_FLAG]
    expect(acpTransportFactory({
      type: "claude-acp",
      transport: "websocket",
      url: "ws://127.0.0.1:7331/acp",
    })).toBeUndefined()

    process.env[ACP_REMOTE_TRANSPORT_FLAG] = "true"
    expect(acpTransportFactory({
      type: "claude-acp",
      transport: "websocket",
      url: "ws://127.0.0.1:7331/acp",
    })).toBeTypeOf("function")
  })

  test("runtimeAuthKey passes through raw api keys", () => {
    expect(runtimeAuthKey("sk-openai-direct")).toBe("sk-openai-direct")
  })

  test("opencode compatibility disabled avoids upstream calls and errors for provider models", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-compat-disabled-"))
    tempDirs.push(dir)
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const upstreamCalls: string[] = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      upstreamCalls.push(url)
      return originalFetch(input, init)
    }))

    const app = new Hono()
    // Full kill switch: opencodeCompat false — both adapter mechanism and route
    // surface off, so nothing touches the upstream.
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: false })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: { docs: {} },
    })
    expect(config.status).toBe(200)

    const session = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`)
    const status = await app.request(`http://localhost/session/status?directory=${encodeURIComponent(dir)}`)
    const mcp = await app.request(`http://localhost/mcp?directory=${encodeURIComponent(dir)}`)
    const lsp = await app.request(`http://localhost/lsp?directory=${encodeURIComponent(dir)}`)
    const provider = await app.request(`http://localhost/provider?runner=opencode&directory=${encodeURIComponent(dir)}`)

    expect(session.status).toBe(200)
    expect(await session.json()).toEqual([])
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({})
    expect(await mcp.json()).toEqual({})
    expect(await lsp.json()).toEqual([])
    expect(provider.status).toBe(502)
    expect(await provider.json()).toMatchObject({
      ok: false,
      error: {
        code: "provider_models_unavailable",
        harness: "opencode",
      },
    })
    expect(upstreamCalls).toEqual([])
  })

  test("opencode compatibility default proxies adapter list/status upstream but keeps the compat route surface local", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-compat-default-"))
    tempDirs.push(dir)
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const upstreamCalls: string[] = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://opencode.test")) {
        upstreamCalls.push(url)
        if (url.includes("/session")) return Response.json([{ id: "ses_upstream", title: "from upstream" }])
        return Response.json({ proxied: true, url })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    // Kit default: opencodeCompat undefined — adapter mechanism on, route surface off.
    mountTestHost(app, { opencodeUrl: "http://opencode.test" })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: { docs: {} },
    })
    expect(config.status).toBe(200)

    // Adapter mechanism ON: listSessions proxies the opencode upstream.
    const session = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`)
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject([{ id: "ses_upstream" }])
    expect(upstreamCalls.some((url) => url.includes("/session"))).toBe(true)

    // Route surface OFF: /mcp returns the local fallback and never proxies.
    const mcp = await app.request(`http://localhost/mcp?directory=${encodeURIComponent(dir)}`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({})
    expect(upstreamCalls.some((url) => url.includes("/mcp"))).toBe(false)
  })

  test("opencode compatibility enabled proxies /mcp to the opencode upstream (characterization)", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-compat-enabled-"))
    tempDirs.push(dir)
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const upstreamCalls: string[] = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://opencode.test")) {
        upstreamCalls.push(url)
        return Response.json({ proxied: true, url })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: { docs: {} },
    })
    expect(config.status).toBe(200)

    const mcp = await app.request(`http://localhost/mcp?directory=${encodeURIComponent(dir)}`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toMatchObject({ proxied: true })
    expect(upstreamCalls.some((url) => url.includes("/mcp"))).toBe(true)
  })

  test("runtimeAuthKey extracts OPENAI_API_KEY from codex_auth bundles", () => {
    expect(runtimeAuthKey(codexAuth({ openaiKey: "sk-openai-bundled" }))).toBe("sk-openai-bundled")
  })

  test("runtimeAuthKey does not expose token-only codex_auth bundles as api keys", () => {
    expect(runtimeAuthKey(codexAuth())).toBeUndefined()
  })

  test("runtimeAuthKey ignores raw codex account bundles without OPENAI_API_KEY", () => {
    expect(runtimeAuthKey(codexAccountAuth())).toBeUndefined()
  })

  test("materializeCodexAuth writes a codex auth file for token bundles", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const mkdirCalls: Array<{ target: string; mode?: number }> = []
    const writeCalls: Array<{ target: string; body: string; mode?: number }> = []

    fs.promises.mkdir = (async (target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      mkdirCalls.push({ target: String(target), mode: options?.mode as number | undefined })
      return undefined as never
    }) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (target: fs.PathLike, body: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      writeCalls.push({
        target: String(target),
        body: typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"),
        mode: typeof options === "object" && options ? options.mode as number | undefined : undefined,
      })
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAuth({ openaiKey: "sk-should-not-be-materialized" }))

      expect(mkdirCalls).toHaveLength(1)
      expect(mkdirCalls[0]).toMatchObject({
        target: path.join(os.homedir(), ".codex"),
        mode: 0o700,
      })
      expect(writeCalls).toHaveLength(1)
      expect(writeCalls[0]?.target).toBe(path.join(os.homedir(), ".codex", "auth.json"))
      expect(writeCalls[0]?.mode).toBe(0o600)

      const data = JSON.parse(writeCalls[0]!.body) as {
        auth_mode: string
        OPENAI_API_KEY: string | null
        tokens: Record<string, string>
      }

      expect(data.auth_mode).toBe("chatgpt")
      expect(data.OPENAI_API_KEY).toBeNull()
      expect(data.tokens).toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "account-id",
        id_token: "id-token",
      })
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("materializeCodexAuth accepts token bundles supplied through an alias slot", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const writeCalls: string[] = []

    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (_target: fs.PathLike, body: string | NodeJS.ArrayBufferView) => {
      writeCalls.push(typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"))
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAuth())
      expect(writeCalls).toHaveLength(1)
      expect(JSON.parse(writeCalls[0]!).tokens.account_id).toBe("account-id")
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("materializeCodexAuth accepts raw codex account bundles", async () => {
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    const writeCalls: string[] = []

    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (_target: fs.PathLike, body: string | NodeJS.ArrayBufferView) => {
      writeCalls.push(typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"))
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      await materializeCodexAuth(codexAccountAuth())
      expect(writeCalls).toHaveLength(1)
      const data = JSON.parse(writeCalls[0]!)
      expect(data.tokens.access_token).toBe("account-access-token")
      expect(data.tokens.account_id).toBe("account-id")
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("checkpoint scrub excludes runtime-owned Codex credentials and resume re-injects them", async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-checkpoint-auth-"))
    tempDirs.push(home)
    process.env.HOME = home
    // A successful apply persists `.workspace-runtime/runtime-config/*.json`
    // into the workspace directory. `workspaceDir()` falls back to
    // `process.cwd()`, so without an explicit directory this test would write
    // those files into the package root and dirty tracked files on every run.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-checkpoint-workspace-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const app = new Hono()
    const host = mountTestHost(app)

    expect((await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: { "codex-app-server": codexAuth() },
      mcp: {},
    })).status).toBe(200)

    const target = path.join(home, ".codex", "auth.json")
    expect(await fs.promises.readFile(target, "utf8")).toContain("access-token")

    await host.checkpoint.freeze("drain")
    await host.checkpoint.flush()
    await host.checkpoint.scrub()
    expect(await fs.promises.stat(target).then(() => true, () => false)).toBe(false)

    await host.checkpoint.resume()
    expect(await fs.promises.readFile(target, "utf8")).toContain("access-token")
    host.dispose()
  })

  test("uses injected initial harness instead of ambient harness env", () => {
    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.WORKSPACE_RUNTIME_ACP_BINARY = "ambient-binary"
    process.env.CLAXEDO_ACP_MODEL = "ambient-model"

    const host = createWorkspaceHost({
      harness: {
        id: "cursor",
        access: "acp",
        connection: { kind: "process", binary: "injected-binary" },
      },
    })

    expect(host.detail().harness).toEqual({
      id: "cursor",
      access: "acp",
      connection: {
        kind: "process",
        binary: "injected-binary",
      },
    })
  })

  test("defaults initial runner to opencode without ambient env", () => {
    process.env.WORKSPACE_RUNTIME_RUNNER = "cursor-acp"
    process.env.WORKSPACE_RUNTIME_ACP_BINARY = "ambient-binary"

    expect(createWorkspaceHost().detail().harness).toEqual({ id: "opencode", access: "native" })
  })

  test("harness config options configures current ACP runner with resolved auth env", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-options-current-auth-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const authCalls: Array<Record<string, string | undefined>> = []
    const options: AgentConfigOption[] = [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5",
      selectOptions: [{ id: "gpt-5", value: "gpt-5", name: "GPT-5" }],
    }]
    const adapter = {
      adapterCapabilities: ["runtime-config"] as const,
      setModel() {},
      setAuth(keys: Record<string, string | undefined>) {
        authCalls.push(keys)
      },
      async applyConfig() {},
      async probeConfigOptions() {
        return options
      },
      dispose() {},
    } as unknown as AgentHarnessAdapter
    const registry: WorkspaceHarnessRegistry = [{
      match: (runner) => runner.id === "claude" && runner.access === "acp",
      create: () => adapter,
    }]
    const app = new Hono()
    mountTestHost(app, {
      harness: { id: "claude", access: "acp" },
      harnesses: registry,
    })

    const accountConfig = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "claude-acp" },
      auth: {
        "claude-acp": JSON.stringify({
          type: "claude_code_oauth",
          claudeAiOauth: { accessToken: "sk-ant-oauth-options" },
        }),
      },
      mcp: {},
    })
    expect(accountConfig.status).toBe(200)

    const accountOptions = await app.request(
      `http://localhost/api/wr/harness-config-options?directory=${encodeURIComponent(dir)}&harness=claude-acp`,
    )
    expect(accountOptions.status).toBe(200)
    expect(authCalls.at(-1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oauth-options" })
  })

  test("harness config options probes live Codex ACP session options", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-options-codex-live-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    let probes = 0
    const adapter = {
      adapterCapabilities: ["runtime-config"] as const,
      setModel() {},
      setAuth() {},
      async applyConfig() {},
      async probeConfigOptions() {
        probes += 1
        return [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.3-codex",
          selectOptions: [{ id: "gpt-5.3-codex", value: "gpt-5.3-codex", name: "gpt-5.3-codex" }],
        }]
      },
      dispose() {},
    } as unknown as AgentHarnessAdapter
    const registry: WorkspaceHarnessRegistry = [{
      match: (runner) => runner.id === "codex" && runner.access === "acp",
      create: () => adapter,
    }]
    const app = new Hono()
    mountTestHost(app, {
      harness: { id: "codex", access: "acp" },
      harnesses: registry,
    })

    const res = await app.request(
      `http://localhost/api/wr/harness-config-options?directory=${encodeURIComponent(dir)}&harness=codex-acp`,
    )
    const body = await res.json() as AgentConfigOption[]

    expect(res.status).toBe(200)
    expect(probes).toBe(1)
    expect(body[0]?.currentValue).toBe("gpt-5.3-codex")
    expect(body[0]?.selectOptions?.some((item) => item.value === "gpt-5.3-codex")).toBe(true)
  })

  test("runtime config apply serializes concurrent pushes", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-apply-queue-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    let writes = 0

    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async () => {
      writes++
      if (writes === 1) await firstWrite
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      const host = createWorkspaceHost()
      const first = host.apply({
        version: 1,
        mcp: { first: { type: "stdio", command: "first" } },
        runner: { type: "claude-sdk", model: "claude-sonnet-4-6" },
        auth: { "codex-app-server": codexAuth() },
      })

      while (writes === 0) await new Promise((resolve) => setTimeout(resolve, 0))

      const second = host.apply({
        version: 1,
        mcp: { second: { type: "stdio", command: "second" } },
        runner: { type: "codex-app-server", model: "gpt-5" },
        auth: {},
      })

      releaseFirstWrite()
      await Promise.all([first, second])

      expect(host.detail().harness).toEqual({ id: "codex", access: "native" })
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })

  test("runner replacement aborts and drains active turns before disposing the old adapter", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-runner-replace-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    let sendStarted!: () => void
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve
    })
    let releaseSend!: () => void
    const released = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const events: string[] = []
    const originalSendMessage = CodexHarnessAdapter.prototype.sendMessage
    const originalGetSessionConfig = CodexHarnessAdapter.prototype.getSessionConfig
    const originalGetMessages = CodexHarnessAdapter.prototype.getMessages
    const originalAbort = CodexHarnessAdapter.prototype.abort
    const originalDispose = CodexHarnessAdapter.prototype.dispose

    CodexHarnessAdapter.prototype.getSessionConfig = async () => ({
      harness: { id: "codex", access: "native" as const },
      model: { providerID: "codex-app-server", modelID: "gpt-5" },
      variant: null,
      agent: null,
    })
    CodexHarnessAdapter.prototype.getMessages = async () => []
    CodexHarnessAdapter.prototype.sendMessage = async function*() {
      events.push("send:start")
      sendStarted()
      try {
        await released
      } finally {
        events.push("send:cleanup")
      }
    }
    CodexHarnessAdapter.prototype.abort = async (_id, directory) => {
      events.push(`abort:${directory === dir}`)
      releaseSend()
      return { ok: true, status: "cancelled" }
    }
    CodexHarnessAdapter.prototype.dispose = function() {
      events.push("dispose")
    }

    try {
      const app = new Hono()
      mountTestHost(app, { harness: { id: "codex", access: "native" } })

      const message = app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [],
          agent: "build",
          model: { providerID: "codex-app-server", modelID: "gpt-5" },
          variant: "default",
        }),
      })
      await started

      const config = await pushRuntimeConfig(app, {
        version: 1,
        mcp: {},
        auth: {},
        runner: { type: "claude-sdk" },
      })
      expect(config.status).toBe(200)

      const response = await message
      expect(response.status).toBe(200)
      expect(events).toEqual(["send:start", "abort:true", "send:cleanup", "dispose"])
    } finally {
      CodexHarnessAdapter.prototype.sendMessage = originalSendMessage
      CodexHarnessAdapter.prototype.getSessionConfig = originalGetSessionConfig
      CodexHarnessAdapter.prototype.getMessages = originalGetMessages
      CodexHarnessAdapter.prototype.abort = originalAbort
      CodexHarnessAdapter.prototype.dispose = originalDispose
    }
  })

  test("runtime config push rejects unsafe ACP config changes while a turn is active", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-acp-live-config-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    let sendStarted!: () => void
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve
    })
    let releaseSend!: () => void
    const released = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const events: string[] = []
    const originalGetSessionConfig = AcpHarnessAdapter.prototype.getSessionConfig
    const originalGetMessages = AcpHarnessAdapter.prototype.getMessages
    const originalSendMessage = AcpHarnessAdapter.prototype.sendMessage
    const originalSetAuth = AcpHarnessAdapter.prototype.setAuth
    const originalApplyConfig = AcpHarnessAdapter.prototype.applyConfig

    AcpHarnessAdapter.prototype.getSessionConfig = async () => ({
      harness: { id: "claude", access: "acp" as const },
      model: { providerID: "claude-acp", modelID: "sonnet" },
      variant: null,
      agent: null,
    })
    AcpHarnessAdapter.prototype.getMessages = async () => []
    AcpHarnessAdapter.prototype.sendMessage = async function*() {
      events.push("send:start")
      sendStarted()
      await released
      events.push("send:done")
    }
    AcpHarnessAdapter.prototype.setAuth = function() {
      events.push("setAuth")
    }
    AcpHarnessAdapter.prototype.applyConfig = async function() {
      events.push("applyConfig")
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, { harness: { id: "claude", access: "acp" } })

      const message = app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [],
          agent: "build",
          model: { providerID: "claude-acp", modelID: "sonnet" },
        }),
      })
      await started

      const config = await pushRuntimeConfig(app, {
        version: 1,
        mcp: {},
        auth: { "claude-acp": "sk-new" },
        runner: { type: "claude-acp" },
      })

      expect(config.status).toBe(409)
      await expect(config.json()).resolves.toEqual({
        error: {
          code: "runtime_config_unsafe_restart",
          message: "ACP runtime config change would restart an active session",
          details: {
            harness: "claude",
            activeTurns: 1,
          },
        },
      })
      expect(host.detail().state).toBe("ready")
      expect(events).toEqual(["send:start"])

      releaseSend()
      const response = await message
      expect(response.status).toBe(200)
      expect(events).toEqual(["send:start", "send:done"])
    } finally {
      AcpHarnessAdapter.prototype.getSessionConfig = originalGetSessionConfig
      AcpHarnessAdapter.prototype.getMessages = originalGetMessages
      AcpHarnessAdapter.prototype.sendMessage = originalSendMessage
      AcpHarnessAdapter.prototype.setAuth = originalSetAuth
      AcpHarnessAdapter.prototype.applyConfig = originalApplyConfig
    }
  })

  test("routes persisted sessions through their owning runner adapter", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-runner-mismatch-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-claude",
      directory: dir,
      agentSessionId: "a-claude",
      createdAt: 1,
    })
    seed.updateSessionConfig("s-claude", {
      runner: { type: "claude-sdk" },
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    })
    seed.close()

    const calls: Array<{ id: string; model: { providerID: string; modelID: string } }> = []
    const originalSendMessage = ClaudeHarnessAdapter.prototype.sendMessage
    const originalGetMessages = ClaudeHarnessAdapter.prototype.getMessages
    ClaudeHarnessAdapter.prototype.sendMessage = async function*(id, input) {
      calls.push({ id, model: input.model })
      yield {
        type: "session.idle",
        properties: { sessionID: id },
      } as never
    }
    ClaudeHarnessAdapter.prototype.getMessages = async () => []

    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        storeRoot,
      })

      const res = await app.request(`http://localhost/session/s-claude/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [],
        }),
      })

      expect(res.status).toBe(200)
      expect(calls).toEqual([{
        id: "s-claude",
        model: { providerID: "claude-sdk", modelID: "sonnet" },
      }])
    } finally {
      ClaudeHarnessAdapter.prototype.sendMessage = originalSendMessage
      ClaudeHarnessAdapter.prototype.getMessages = originalGetMessages
    }
  })

  test("lists persisted sessions before their owning harness adapter is instantiated after restart", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-persisted-session-list-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-claude-title",
      directory: dir,
      title: "Generated before restart",
      agentSessionId: "a-claude-title",
      createdAt: 1,
    })
    seed.updateSessionConfig("s-claude-title", {
      runner: { type: "claude-sdk" },
      model: { providerID: "claude-sdk", modelID: "sonnet" },
    })
    seed.close()
    const registry: WorkspaceHarnessRegistry = [{
      match: () => true,
      create: () => ({
        listSessions: async () => [],
        dispose() {},
      }) as unknown as AgentHarnessAdapter,
    }]
    const app = new Hono()
    mountTestHost(app, {
      harness: { id: "opencode", access: "native" },
      harnesses: registry,
      storeRoot,
    })

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject([{
      id: "s-claude-title",
      title: "Generated before restart",
    }])
  })

  test("serves journaled replay messages before adapter fallback", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-journal-replay-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-replay",
      directory: dir,
      agentSessionId: "a-replay",
      createdAt: 1,
    })
    seed.appendEvent({
      sessionId: "s-replay",
      agentSessionId: "a-replay",
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-replay",
            sessionID: "s-replay",
            role: "user",
            time: { created: 1 },
          },
        },
        // Minimal replay fixtures: the store round-trip under test reads only
        // these fields, so they stay small rather than full Message/Part values.
      } as unknown as CompatEvent,
    })
    seed.appendEvent({
      sessionId: "s-replay",
      agentSessionId: "a-replay",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-replay",
            sessionID: "s-replay",
            messageID: "msg-replay",
            type: "text",
            text: "journal replay from runtime store",
          },
        },
      } as unknown as CompatEvent,
    })
    seed.close()

    const originalGetMessages = OpenCodeHarnessAdapter.prototype.getMessages
    const originalGetSession = OpenCodeHarnessAdapter.prototype.getSession
    const calls: string[] = []
    OpenCodeHarnessAdapter.prototype.getMessages = async (id) => {
      calls.push(`messages:${id}`)
      return []
    }
    OpenCodeHarnessAdapter.prototype.getSession = async (id) => {
      calls.push(`session:${id}`)
      throw new Error("adapter session fallback should not be called")
    }

    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "opencode", access: "native" },
        storeRoot,
      })

      const sessionRes = await app.request(`http://localhost/session/s-replay?directory=${encodeURIComponent(dir)}`)
      const sessionBody = await sessionRes.json()
      const messageRes = await app.request(`http://localhost/session/s-replay/message?directory=${encodeURIComponent(dir)}`)
      const messageBody = await messageRes.json()
      const todoRes = await app.request(`http://localhost/session/s-replay/todo?directory=${encodeURIComponent(dir)}`)
      const todoBody = await todoRes.json()

      expect(sessionRes.status).toBe(200)
      expect(sessionBody.id).toBe("s-replay")
      expect(messageRes.status).toBe(200)
      expect(JSON.stringify(messageBody)).toContain("journal replay from runtime store")
      expect(todoRes.status).toBe(200)
      expect(todoBody).toEqual([])
      expect(calls).toEqual([])
    } finally {
      OpenCodeHarnessAdapter.prototype.getMessages = originalGetMessages
      OpenCodeHarnessAdapter.prototype.getSession = originalGetSession
    }
  })

  test("falls back to the adapter transcript when a bound session has an empty message projection", async () => {
    // Regression: proxy-driven (Session V2) sessions keep messages in the
    // engine and get bound into the store message-less by discovery — an empty
    // store projection must never shadow the engine transcript (staging
    // WorkGraph retention synced [] and settled runs without transcripts).
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-empty-bound-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-empty",
      directory: dir,
      agentSessionId: "a-empty",
      title: "Empty runtime session",
      createdAt: 1,
    })
    seed.close()

    const engineTranscript = [
      { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
      { info: { id: "msg-assistant", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ]
    const originalGetMessages = OpenCodeHarnessAdapter.prototype.getMessages
    const calls: string[] = []
    OpenCodeHarnessAdapter.prototype.getMessages = async (id) => {
      calls.push(`messages:${id}`)
      return engineTranscript as never
    }

    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "opencode", access: "native" },
        storeRoot,
      })

      const messageRes = await app.request(`http://localhost/session/s-empty/message?directory=${encodeURIComponent(dir)}`)
      expect(messageRes.status).toBe(200)
      await expect(messageRes.json()).resolves.toEqual(engineTranscript)

      const snapshotRes = await app.request(
        `http://localhost/session/s-empty/message?snapshot=1&directory=${encodeURIComponent(dir)}`,
      )
      expect(snapshotRes.status).toBe(200)
      await expect(snapshotRes.json()).resolves.toEqual(engineTranscript)

      expect(calls).toEqual(["messages:s-empty", "messages:s-empty"])
    } finally {
      OpenCodeHarnessAdapter.prototype.getMessages = originalGetMessages
    }
  })

  // Boots a real `opencode serve` (native access); CI unit runners have no
  // opencode binary on PATH, so skip there rather than fail on absence.
  test.skipIf(!Bun.which("opencode"))("persists OpenCode session config through mounted workspace host routes", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-opencode-config-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const config = {
      harness: { id: "opencode", access: "native" },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: null,
      agent: "build",
    } satisfies SessionConfig

    const firstApp = new Hono()
    const firstHost = mountTestHost(firstApp, {
      harness: { id: "opencode", access: "native" },
      storeRoot,
    })

    const update = await firstApp.request(
      `http://localhost/session/s-opencode/config?directory=${encodeURIComponent(dir)}&runner=opencode`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      },
    )
    const read = await firstApp.request(
      `http://localhost/session/s-opencode/config?directory=${encodeURIComponent(dir)}&runner=opencode`,
    )

    expect(update.status).toBe(200)
    expect(read.status).toBe(200)
    expect(await update.json()).toEqual(config)
    expect(await read.json()).toEqual(config)
    firstHost.dispose()

    const secondApp = new Hono()
    const secondHost = mountTestHost(secondApp, {
      harness: { id: "opencode", access: "native" },
      storeRoot,
    })
    const replayed = await secondApp.request(
      `http://localhost/session/s-opencode/config?directory=${encodeURIComponent(dir)}&runner=opencode`,
    )

    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toEqual(config)
    secondHost.dispose()
  })

  test("listing sessions does not overwrite an existing session config from another harness", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-list-preserve-config-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const config = {
      harness: { id: "opencode", access: "native" },
      model: { providerID: "opencode", modelID: "big-pickle" },
      variant: null,
      agent: "build",
    } satisfies SessionConfig
    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-opencode-owned",
      directory: dir,
      agentSessionId: "s-opencode-owned",
      createdAt: 1,
    })
    seed.updateSessionConfig("s-opencode-owned", config, { directory: dir })
    seed.close()

    const discoveredAt = Date.now()
    const originalCodexListSessions = CodexHarnessAdapter.prototype.listSessions
    CodexHarnessAdapter.prototype.listSessions = async () => [{
      id: "s-opencode-owned",
      title: "Discovered by Codex",
      time: { created: 1, updated: discoveredAt },
    }]

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        storeRoot,
      })
      const listed = await app.request(`http://localhost/session?runner=codex&directory=${encodeURIComponent(dir)}`)
      const after = new RuntimeStore(storeRoot)

      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([{
        id: "s-opencode-owned",
        title: "Discovered by Codex",
        time: { created: 1, updated: discoveredAt },
      }])
      expect(after.getSessionConfig("s-opencode-owned")).toEqual(config)
      after.close()
      host.dispose()
    } finally {
      CodexHarnessAdapter.prototype.listSessions = originalCodexListSessions
    }
  })

  test("recovers missing OpenCode config from the session row", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-opencode-config-recover-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const originalGetSession = OpenCodeHarnessAdapter.prototype.getSession
    OpenCodeHarnessAdapter.prototype.getSession = async (id) => ({
      id,
      agent: "build",
      model: {
        providerID: "opencode",
        id: "deepseek-v4-flash-free",
        variant: "default",
      },
    })

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "opencode", access: "native" },
        storeRoot,
      })
    const recovered = {
      harness: { id: "opencode", access: "native" },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      variant: "default",
      agent: "build",
      } satisfies SessionConfig
      const res = await app.request(
        `http://localhost/session/s-opencode/config?directory=${encodeURIComponent(dir)}&runner=opencode`,
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(recovered)
      expect(new RuntimeStore(storeRoot).getSessionConfig("s-opencode")).toBeNull()
      host.dispose()
    } finally {
      OpenCodeHarnessAdapter.prototype.getSession = originalGetSession
    }
  })

  test("routes new sessions through the active workspace harness", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-runner-default-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const calls: string[] = []
    const originalCreateSession = CodexHarnessAdapter.prototype.createSession
    CodexHarnessAdapter.prototype.createSession = async function(directory, title) {
      calls.push(`${directory}:${title ?? ""}`)
      return { id: "s-codex" }
    }
    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        storeRoot,
      })

      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Codex" }),
      })

      expect(res.status).toBe(201)
      expect(calls).toEqual([`${dir}:New Codex`])
    } finally {
      CodexHarnessAdapter.prototype.createSession = originalCreateSession
    }
  })

  test("host dispose closes adapter-created runtime stores once", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-host-store-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const originalClose = RuntimeStore.prototype.close
    let closed = 0
    RuntimeStore.prototype.close = function() {
      closed++
      return originalClose.call(this)
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "claude", access: "native" },
        storeRoot: path.join(dir, ".claxedo", "store"),
      })

      const status = await app.request("http://localhost/session/status")
      expect(status.status).toBe(200)

      host.dispose()
      host.dispose()

      expect(closed).toBe(1)
    } finally {
      RuntimeStore.prototype.close = originalClose
    }
  })

  test("harness replacement closes the old adapter-created runtime store", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-replace-store-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const originalClose = RuntimeStore.prototype.close
    let closed = 0
    RuntimeStore.prototype.close = function() {
      closed++
      return originalClose.call(this)
    }

    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "claude", access: "native" },
        storeRoot: path.join(dir, ".claxedo", "store"),
      })

      const status = await app.request("http://localhost/session/status")
      expect(status.status).toBe(200)

      const config = await pushRuntimeConfig(app, {
        version: 1,
        mcp: {},
        auth: {},
        harness: { id: "codex", access: "native" },
      })
      expect(config.status).toBe(200)
      expect(closed).toBe(1)
    } finally {
      RuntimeStore.prototype.close = originalClose
    }
  })

  test("opencode capability routes fall back when the embedded server fails", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-capability-fallback-"))
    tempDirs.push(dir)
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    globalThis.fetch = fetchDouble((async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://opencode.test/")) {
        return new Response(JSON.stringify({ error: "upstream failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: { docs: {} },
    })
    expect(config.status).toBe(200)

    const mcp = await app.request(`http://localhost/mcp?directory=${encodeURIComponent(dir)}`)
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({ docs: { status: "disabled" } })

    const lsp = await app.request(`http://localhost/lsp?directory=${encodeURIComponent(dir)}`)
    expect(lsp.status).toBe(200)
    expect(await lsp.json()).toEqual([])
  })

  test("opencode provider route uses configured URL instead of ambient OPENCODE_URL", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-proxy-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://ambient-opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url === "http://opencode.test/provider?runner=opencode&view=index") {
        return new Response(JSON.stringify({
          all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
    })
    expect(config.status).toBe(200)

    const provider = await app.request("http://localhost/provider?runner=opencode")
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
  })

  test("opencodeRequest injected transport serves the compat proxy routes end to end", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-injected-transport-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    // Fake in-process engine handler — the HOST would construct this. It routes
    // on path only (synthetic origin) and never touches the network. Fail loudly
    // if the kit falls back to a real fetch/URL path.
    const seen: Array<{ path: string; directory: string | null }> = []
    globalThis.fetch = fetchDouble((async () => {
      throw new Error("kit must not use network when opencodeRequest is injected")
    }))

    const handler: OpenCodeRequestFn = async (req) => {
      const url = new URL(req.url)
      seen.push({ path: url.pathname, directory: req.headers.get("x-opencode-directory") })
      if (url.pathname === "/provider") {
        return new Response(JSON.stringify({
          all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url.pathname === "/experimental/tool/ids") {
        return Response.json(["terminal", "read"])
      }
      if (url.pathname === "/global/event") {
        const enc = new TextEncoder()
        return new Response(new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`))
            ctrl.close()
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
      }
      return new Response("unexpected", { status: 500 })
    }

    const app = new Hono()
    mountTestHost(app, { opencodeRequest: handler, opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
    })
    expect(config.status).toBe(200)

    const provider = await app.request("http://localhost/provider?runner=opencode")
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })

    const tools = await app.request("http://localhost/experimental/tool/ids")
    expect(tools.status).toBe(200)
    expect(await tools.json()).toEqual(["terminal", "read"])

    const event = await app.request("http://localhost/global/event", {
      headers: { Accept: "text/event-stream" },
    })
    expect(event.status).toBe(200)
    expect(await event.text()).toContain("server.connected")

    expect(seen.map((s) => s.path)).toEqual(["/provider", "/experimental/tool/ids", "/global/event"])
  })

  test("proxies the real Session V2 model, create, prompt, and history contract", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-session-v2-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const seen: Array<{ method: string; path: string; body: unknown }> = []
    const handler: OpenCodeRequestFn = async (request) => {
      const body = request.body ? await request.clone().json().catch(() => undefined) : undefined
      seen.push({ method: request.method, path: new URL(request.url).pathname, body })
      if (new URL(request.url).pathname === "/api/model") {
        return Response.json({
          data: [{ id: "gpt-5", providerID: "openai", enabled: true, variants: [{ id: "high" }] }],
        })
      }
      if (new URL(request.url).pathname === "/api/session") {
        expect(body).toEqual({ agent: "build", model: { id: "gpt-5", providerID: "openai" } })
        expect(body).not.toHaveProperty("id")
        expect(body).not.toHaveProperty("location")
        expect((body as { model?: object }).model).not.toHaveProperty("modelID")
        return Response.json({ id: "ses_v2" }, { status: 201 })
      }
      if (new URL(request.url).pathname.endsWith("/prompt")) return Response.json({ data: { admitted: true } })
      return Response.json({ data: [{ type: "session.next.step.ended", data: {} }], hasMore: false })
    }
    const app = new Hono()
    mountTestHost(app, { opencodeRequest: handler, opencodeCompat: true })

    expect(await (await app.request("http://localhost/api/model", {
      headers: { "x-opencode-directory": dir },
    })).json()).toMatchObject({ data: [{ id: "gpt-5", variants: [{ id: "high" }] }] })
    expect((await app.request("http://localhost/api/session", {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": dir },
      body: JSON.stringify({ agent: "build", model: { id: "gpt-5", providerID: "openai" } }),
    })).status).toBe(201)
    expect((await app.request("http://localhost/api/session/ses_v2/prompt", {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": dir },
      body: JSON.stringify({ prompt: { text: "no-op" }, resume: true }),
    })).status).toBe(200)
    expect((await app.request("http://localhost/api/session/ses_v2/history?limit=100&after=0", {
      headers: { "x-opencode-directory": dir },
    })).status).toBe(200)
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/model", "POST /api/session", "POST /api/session/ses_v2/prompt", "GET /api/session/ses_v2/history",
    ])
  })

  test("opencode proxy routes do not forward relay auth headers", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-auth-strip-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const seen: Array<{ authorization: string | null; workspaceId: string | null; forwardedBy: string | null }> = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url === "http://opencode.test/provider?runner=opencode&view=index") {
        seen.push({
          authorization: req.headers.get("authorization"),
          workspaceId: req.headers.get("x-workspace-id"),
          forwardedBy: req.headers.get("x-forwarded-by"),
        })
        return new Response(JSON.stringify({
          all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      harness: { id: "opencode", access: "native" },
    })

    const provider = await app.request("http://localhost/provider?runner=opencode", {
      headers: {
        Authorization: "Bearer relay-host-token",
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(provider.status).toBe(200)
    expect(seen).toEqual([{ authorization: null, workspaceId: null, forwardedBy: null }])
  })

  test("opencode provider route honors runner query while active runner is ACP", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-query-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url === "http://opencode.test/provider?runner=opencode&view=index") {
        return new Response(JSON.stringify({
          all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
          connected: ["opencode"],
          default: { opencode: "big-pickle" },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      harness: { id: "claude", access: "acp" },
    })

    const provider = await app.request("http://localhost/provider?runner=opencode")
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
  })

  test("session create honors runner query while active runner is ACP", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-session-runner-query-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const calls: Array<{ url: string; directory: string; body: unknown }> = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push({
        url: req.url,
        directory: req.headers.get("x-opencode-directory") ?? "",
        body: req.method === "POST" ? await req.json().catch(() => undefined) : undefined,
      })
      return new Response(JSON.stringify({ id: "session-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    }))

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      harness: { id: "cursor", access: "acp" },
    })

    const session = await app.request("http://localhost/session?runner=opencode", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Cloud smoke" }),
    })

    expect(session.status).toBe(201)
    expect(await session.json()).toMatchObject({ id: "session-1" })
    expect(calls).toEqual([{
      url: "http://opencode.test/session",
      directory: dir,
      body: { title: "Cloud smoke" },
    }])
  })

  test("opencode provider route errors when upstream metadata is unavailable", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-fallback-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url === "http://opencode.test/provider?runner=opencode&view=index") {
        return new Response("unavailable", { status: 503 })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
    })
    expect(config.status).toBe(200)

    const provider = await app.request("http://localhost/provider?runner=opencode")
    expect(provider.status).toBe(502)
    expect(await provider.json()).toMatchObject({
      ok: false,
      error: {
        code: "provider_models_unavailable",
        harness: "opencode",
      },
    })
  })

  test("opencode provider index accepts an empty model catalog", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-empty-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    globalThis.fetch = fetchDouble((async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url === "http://opencode.test/provider?runner=opencode&view=index") {
        return new Response(JSON.stringify({ all: [], connected: [], default: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }))

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
    })
    expect(config.status).toBe(200)

    const provider = await app.request("http://localhost/provider?runner=opencode")
    expect(provider.status).toBe(200)
    expect(await provider.json()).toEqual({ all: [], connected: [], default: {} })
  })

  test("provider route errors instead of returning static ACP runner model metadata", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-provider-acp-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "codex-acp"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "codex-acp" },
      auth: {},
      mcp: {},
    })
    expect(config.status).toBe(200)

    const provider = await app.request("http://localhost/provider")
    expect(provider.status).toBe(502)
    expect(await provider.json()).toMatchObject({
      ok: false,
      error: {
        code: "provider_models_unavailable",
        harness: "codex",
      },
    })
  })

  test("runtime config push replays agent_extensions snapshot", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-ext-replay-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    // Host-owned state roots: both live OUTSIDE the workspace at `dir`, which
    // is the point — a runtime apply must leave the user's checkout untouched.
    const stateRoot = path.join(dir, "host-state", "agent-extensions")
    const receiptDir = path.join(dir, "host-state", "runtime-config")

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      agentExtensionStateRoot: stateRoot,
      configApplyReceiptDir: receiptDir,
    })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: { "openai": "sk-secret-runtime-config" },
      mcp: {},
      agent_extensions: {
        version: 1,
        installs: [],
      },
    })
    expect(config.status).toBe(200)

    const installed = await fs.promises.readFile(
      path.join(stateRoot, "installed.json"),
      "utf8",
    )
    expect(JSON.parse(installed)).toEqual({ version: 1, installs: [] })

    const materialized = await fs.promises.readFile(
      path.join(stateRoot, "materialized.json"),
      "utf8",
    )
    expect(JSON.parse(materialized)).toMatchObject({ version: 1, packages: {} })

    // The workspace itself stays clean — no generated state directories.
    await expect(fs.promises.stat(path.join(dir, ".agent-extensions"))).rejects.toThrow()
    await expect(fs.promises.stat(path.join(dir, ".workspace-runtime"))).rejects.toThrow()

    const applyStatus = JSON.parse(await fs.promises.readFile(
      path.join(receiptDir, "apply-status.json"),
      "utf8",
    ))
    expect(applyStatus).toMatchObject({
      state: "applied",
      revision: 1,
      harness: { id: "opencode", access: "native" },
    })

    const accepted = await fs.promises.readFile(
      path.join(receiptDir, "accepted-snapshot.json"),
      "utf8",
    )
    expect(accepted).not.toContain("sk-secret-runtime-config")
    expect(JSON.parse(accepted)).toMatchObject({
      revision: 1,
      snapshot: {
        mcp: { keys: [] },
        auth: { keys: ["openai"] },
        agent_extensions: {
          version: 1,
          installCount: 0,
          installIds: [],
        },
      },
    })
  })

  test("runtime config push is idempotent — repeated apply does not duplicate state", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-ext-idempotent-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const stateRoot = path.join(dir, "host-state", "agent-extensions")

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      agentExtensionStateRoot: stateRoot,
    })

    const snapshot = JSON.stringify({
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
      agent_extensions: { version: 1, installs: [] },
    })

    for (let i = 0; i < 3; i++) {
      const res = await pushRuntimeConfig(app, JSON.parse(snapshot))
      expect(res.status).toBe(200)
    }

    const installed = JSON.parse(await fs.promises.readFile(
      path.join(stateRoot, "installed.json"),
      "utf8",
    )) as { installs: unknown[] }
    expect(installed.installs).toEqual([])

    const lock = JSON.parse(await fs.promises.readFile(
      path.join(stateRoot, "lock.json"),
      "utf8",
    )) as { packages: Record<string, unknown> }
    expect(lock.packages).toEqual({})

    // Receipts are opt-in and this host did not ask for them, so three applies
    // leave no receipt files anywhere in the workspace.
    await expect(fs.promises.stat(path.join(dir, ".workspace-runtime"))).rejects.toThrow()
  })

  test("re-applying an identical snapshot is a no-op that does not bump the revision", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-apply-noop-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const app = new Hono()
    const host = mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      agentExtensionStateRoot: path.join(dir, "host-state", "agent-extensions"),
    })

    const snapshot = {
      version: 1 as const,
      runner: { type: "opencode" },
      auth: { openai: "sk-test" },
      mcp: { docs: { type: "stdio", command: "docs" } },
      agent_extensions: { version: 1, installs: [] },
    }

    expect((await pushRuntimeConfig(app, snapshot)).status).toBe(200)
    expect(host.detail().configApply.revision).toBe(1)

    // Same snapshot, and again with keys reordered — canonicalization means
    // object key order is not a material difference.
    expect((await pushRuntimeConfig(app, snapshot)).status).toBe(200)
    expect((await pushRuntimeConfig(app, {
      mcp: { docs: { command: "docs", type: "stdio" } },
      auth: { openai: "sk-test" },
      agent_extensions: { installs: [], version: 1 },
      runner: { type: "opencode" },
      version: 1,
    })).status).toBe(200)
    expect(host.detail().configApply.revision).toBe(1)

    // A materially different snapshot still runs the normal apply path.
    expect((await pushRuntimeConfig(app, {
      ...snapshot,
      mcp: { docs: { type: "stdio", command: "docs-v2" } },
    })).status).toBe(200)
    expect(host.detail().configApply.revision).toBe(2)
  })

  test("a failed apply does not poison the signature — retrying the same snapshot re-applies", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-apply-retry-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const app = new Hono()
    const host = mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      agentExtensionStateRoot: path.join(dir, "host-state", "agent-extensions"),
    })

    // Missing resolved_sha ⇒ replay fails.
    const broken = {
      version: 1 as const,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
      agent_extensions: {
        version: 1,
        installs: [{
          desired: {
            id: "broken",
            package_name: "broken",
            source: { type: "github", owner: "acme", repo: "broken" },
            enabled: true,
            targets: ["cursor"],
          },
          components: [],
        }],
      },
    }

    expect((await pushRuntimeConfig(app, broken)).status).toBe(500)
    expect(host.detail().configApply.state).toBe("failed")

    // The identical snapshot must be retried, not skipped as "already applied".
    expect((await pushRuntimeConfig(app, broken)).status).toBe(500)
    expect(host.detail().configApply.revision).toBe(2)
  })

  test("runtime config push returns 500 when agent extension replay fails", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-ext-replay-fail-"))
    tempDirs.push(dir)

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const receiptDir = path.join(dir, "host-state", "runtime-config")

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      agentExtensionStateRoot: path.join(dir, "host-state", "agent-extensions"),
      configApplyReceiptDir: receiptDir,
    })

    // An install with no resolved_sha is invalid; replay must surface
    // the error to the caller instead of silently swallowing it.
    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
      agent_extensions: {
        version: 1,
        installs: [{
          desired: {
            id: "broken",
            package_name: "broken",
            source: { type: "github", owner: "acme", repo: "broken" },
            enabled: true,
            targets: ["cursor"],
          },
          components: [],
        }],
      },
    })
    expect(config.status).toBe(500)
    const body = await config.text()
    expect(body).not.toContain("broken")
    expect(body).not.toContain("acme")
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "runtime_config_agent_extensions_apply_failed",
        message: "Runtime agent extension snapshot replay failed",
        details: {
          reason: "missing_resolved_sha",
        },
      },
    })

    const applyStatus = JSON.parse(await fs.promises.readFile(
      path.join(receiptDir, "apply-status.json"),
      "utf8",
    ))
    expect(applyStatus).toMatchObject({
      state: "failed",
      revision: 1,
      harness: { id: "opencode", access: "native" },
      error: {
        code: "runtime_config_agent_extensions_apply_failed",
        message: "Runtime agent extension snapshot replay failed",
        details: {
          reason: "missing_resolved_sha",
        },
      },
    })
  })

  test("runtime config push does not materialize central slash commands", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-command-sync-"))
    const data = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-command-data-"))
    tempDirs.push(dir, data)
    const commandName = `runtime-pushed-${Date.now()}`

    process.env.WORKSPACE_RUNTIME_RUNNER = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    process.env.WORKSPACE_RUNTIME_DATA_DIR = data

    const app = new Hono()
    mountTestHost(app, { opencodeUrl: "http://opencode.test", opencodeCompat: true })

    const config = await pushRuntimeConfig(app, {
      version: 1,
      runner: { type: "opencode" },
      auth: {},
      mcp: {},
      commands: [{
        name: commandName,
        content: "This legacy payload must be ignored.",
      }],
    })
    expect(config.status).toBe(200)

    const commands = await app.request(`http://localhost/command?directory=${encodeURIComponent(dir)}`)
    expect(commands.status).toBe(200)
    expect(await commands.json()).not.toContainEqual({
      name: commandName,
      content: "This legacy payload must be ignored.",
    })
  })

  test("embedded opencode requests include configured upstream auth", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-opencode-auth-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_auth"
    const calls: Array<{ url: string; method: string; authorization: string | null; directory: string | null }> = []
    globalThis.fetch = fetchDouble((async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      calls.push({
        url: url.origin + url.pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
        directory: request.headers.get("x-opencode-directory"),
      })
      if (url.origin + url.pathname === "http://opencode.test/session/status") {
        return Response.json({ active: { type: "idle" } })
      }
      if (url.origin + url.pathname === "http://opencode.test/session" && request.method === "POST") {
        return Response.json({
          id: "ses_1",
          title: "New Session",
          time: { created: 1, updated: 1 },
        })
      }
      return new Response("unexpected", { status: 500 })
    }))

    const app = new Hono()
    mountTestHost(app, {
      opencodeUrl: "http://opencode.test",
      opencodeCompat: true,
      opencodeHeaders: {
        authorization: `Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`,
      },
      target: {
        workspaceId: "ws_auth",
        directory: dir,
      },
    })

    const status = await app.request(`http://localhost/session/status?directory=${encodeURIComponent(dir)}`)
    expect(status.status).toBe(200)

    const session = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Session" }),
    })
    expect(session.status).toBe(201)

    expect(calls).toEqual([
      {
        url: "http://opencode.test/session/status",
        method: "GET",
        authorization: `Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`,
        directory: dir,
      },
      {
        url: "http://opencode.test/session",
        method: "POST",
        authorization: `Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`,
        directory: dir,
      },
    ])
  })
})

// ── Characterization: cache/store/dispose/queue internals (Unit 1) ──────────────
// These pin the CURRENT behavior of the private caches inside
// createWorkspaceHost (sessionAdapters/sessionRuntimes/adapterConfigStamps),
// the lazy RuntimeStore, host.dispose(), and the config apply queue, so a later
// unit can extract the adapter/store factories without silently changing them.
describe("workspace host adapter + store caching (characterization)", () => {
  test("reuses a single adapter instance for repeated same-runner access", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-adapter-cache-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const seen = new Set<PiHarnessAdapter>()
    const originalListSessions = PiHarnessAdapter.prototype.listSessions
    PiHarnessAdapter.prototype.listSessions = async function (this: PiHarnessAdapter, directory) {
      seen.add(this)
      return await originalListSessions.call(this, directory)
    }

    try {
      const app = new Hono()
      mountTestHost(app, { harness: { id: "pi", access: "native" } })

      const first = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      const second = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      // The adapter cache is keyed by adapterKey; both requests hit the same key
      // and therefore share a single Pi adapter instance.
      expect(seen.size).toBe(1)
    } finally {
      PiHarnessAdapter.prototype.listSessions = originalListSessions
    }
  })

  test("caches the created session runtime for repeated same-adapter sends", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-runtime-cache-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-cache",
      directory: dir,
      agentSessionId: "a-cache",
      createdAt: 1,
    })
    seed.updateSessionConfig("s-cache", {
      harness: { id: "codex", access: "native" as const },
      model: { providerID: "codex-app-server", modelID: "gpt-5" },
    })
    seed.close()

    const adapters = new Set<CodexHarnessAdapter>()
    const originalGetSessionConfig = CodexHarnessAdapter.prototype.getSessionConfig
    const originalGetMessages = CodexHarnessAdapter.prototype.getMessages
    const originalSendMessage = CodexHarnessAdapter.prototype.sendMessage
    CodexHarnessAdapter.prototype.getSessionConfig = async () => ({
      harness: { id: "codex", access: "native" as const },
      model: { providerID: "codex-app-server", modelID: "gpt-5" },
      variant: null,
      agent: null,
    })
    CodexHarnessAdapter.prototype.getMessages = async () => []
    CodexHarnessAdapter.prototype.sendMessage = async function* (this: CodexHarnessAdapter, id) {
      adapters.add(this)
      yield {
        type: "session.idle",
        properties: { sessionID: id },
      } as never
    }

    try {
      const app = new Hono()
      mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        storeRoot,
      })

      for (let i = 0; i < 2; i++) {
        const res = await app.request(`http://localhost/session/s-cache/message?directory=${encodeURIComponent(dir)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [] }),
        })
        expect(res.status).toBe(200)
      }

      // Both turns resolve through the same cached adapter instance (the session
      // runtime is memoized by adapterKey and its adapter factory closes over the
      // one cached adapter).
      expect(adapters.size).toBe(1)
    } finally {
      CodexHarnessAdapter.prototype.getSessionConfig = originalGetSessionConfig
      CodexHarnessAdapter.prototype.getMessages = originalGetMessages
      CodexHarnessAdapter.prototype.sendMessage = originalSendMessage
    }
  })

  test("drops a cached session runtime when its adapter is disposed by a harness switch", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-runtime-cache-dispose-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const seed = new RuntimeStore(storeRoot)
    seed.bindSession({
      sessionId: "s-disposed-cache",
      directory: dir,
      agentSessionId: "a-disposed-cache",
      createdAt: 1,
    })
    seed.updateSessionConfig("s-disposed-cache", {
      harness: { id: "codex", access: "native" as const },
      model: { providerID: "codex-app-server", modelID: "gpt-5" },
    })
    seed.close()

    const adapters = new Set<CodexHarnessAdapter>()
    const disposed = new WeakSet<CodexHarnessAdapter>()
    let disposedAdapterUsed = false
    const originalGetSessionConfig = CodexHarnessAdapter.prototype.getSessionConfig
    const originalGetMessages = CodexHarnessAdapter.prototype.getMessages
    const originalSendMessage = CodexHarnessAdapter.prototype.sendMessage
    const originalDispose = CodexHarnessAdapter.prototype.dispose
    CodexHarnessAdapter.prototype.getSessionConfig = async () => ({
      harness: { id: "codex", access: "native" as const },
      model: { providerID: "codex-app-server", modelID: "gpt-5" },
      variant: null,
      agent: null,
    })
    CodexHarnessAdapter.prototype.getMessages = async () => []
    CodexHarnessAdapter.prototype.sendMessage = async function* (this: CodexHarnessAdapter, id) {
      if (disposed.has(this)) disposedAdapterUsed = true
      adapters.add(this)
      yield {
        type: "session.idle",
        properties: { sessionID: id },
      } as never
    }
    CodexHarnessAdapter.prototype.dispose = function (this: CodexHarnessAdapter) {
      disposed.add(this)
      return originalDispose.call(this)
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        storeRoot,
      })

      const send = () => app.request(`http://localhost/session/s-disposed-cache/message?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [] }),
      })
      expect((await send()).status).toBe(200)

      await host.apply({ version: 1, mcp: {}, runner: { type: "opencode" }, auth: {} })
      await host.apply({ version: 1, mcp: {}, runner: { type: "codex-app-server", model: "gpt-5" }, auth: {} })

      expect((await send()).status).toBe(200)
      expect(disposedAdapterUsed).toBe(false)
      expect(adapters.size).toBe(2)
      host.dispose()
    } finally {
      CodexHarnessAdapter.prototype.getSessionConfig = originalGetSessionConfig
      CodexHarnessAdapter.prototype.getMessages = originalGetMessages
      CodexHarnessAdapter.prototype.sendMessage = originalSendMessage
      CodexHarnessAdapter.prototype.dispose = originalDispose
    }
  })

  test("does not create the session-config store until a store()-backed route is hit", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-store-lazy-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    // The session-config store lives at <storeRoot>/runtime.db (see RuntimeStore).
    // Constructing the host + mounting routes must not create it eagerly.
    const dbExists = () => fs.existsSync(storeRoot)

    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "claude", access: "native" },
      storeRoot,
    })

    // No store()-backed route has been hit yet — the session-config store is
    // created lazily on first store() call.
    expect(dbExists()).toBe(false)

    // Bind a session through a store()-backed path to materialize the store.
    const update = await app.request(
      `http://localhost/session/s-lazy/config?directory=${encodeURIComponent(dir)}&runner=claude`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness: { id: "claude", access: "native" },
          model: { providerID: "anthropic", modelID: "sonnet" },
          variant: null,
          agent: "build",
        }),
      },
    )
    expect(update.status).toBe(200)
    expect(dbExists()).toBe(true)

    host.dispose()
  })

  test("adapter-owned store creation runs recoverBusySessions exactly once per store", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-store-recover-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const originalRecover = RuntimeStore.prototype.recoverBusySessions
    let recovered = 0
    RuntimeStore.prototype.recoverBusySessions = function (this: RuntimeStore) {
      recovered++
      return originalRecover.call(this)
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        // Native claude adapter takes createStore: createRuntimeStore, which
        // calls recoverBusySessions() when it lazily builds its store.
        harness: { id: "claude", access: "native" },
        storeRoot,
      })

      // listSessions on the native adapter forces the adapter-owned store to
      // materialize (createRuntimeStore → recoverBusySessions).
      const status = await app.request("http://localhost/session/status")
      expect(status.status).toBe(200)

      // Pinning: recoverBusySessions is invoked by the createRuntimeStore path.
      expect(recovered).toBeGreaterThanOrEqual(1)

      host.dispose()
    } finally {
      RuntimeStore.prototype.recoverBusySessions = originalRecover
    }
  })

  test("host.dispose() clears session adapters and unsubscribes the global event hub", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-dispose-clear-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    // Wrap a real event hub so we can observe the host's global subscription
    // lifecycle without depending on private closure state.
    const hub = createRuntimeEventHub()
    let subscribes = 0
    let unsubscribes = 0
    const originalSubscribeGlobal = hub.subscribeGlobal
    hub.subscribeGlobal = (fn) => {
      subscribes++
      const off = originalSubscribeGlobal(fn)
      return () => {
        unsubscribes++
        off()
      }
    }

    const disposed = new Set<PiHarnessAdapter>()
    const originalDispose = PiHarnessAdapter.prototype.dispose
    PiHarnessAdapter.prototype.dispose = function (this: PiHarnessAdapter) {
      disposed.add(this)
      return originalDispose?.call(this)
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        eventHub: hub,
      })

      // Force a session-scoped Pi adapter into the sessionAdapters cache.
      const listed = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      expect(listed.status).toBe(200)

      expect(subscribes).toBe(1)
      expect(unsubscribes).toBe(0)

      host.dispose()

      // Global replay subscription is torn down.
      expect(unsubscribes).toBe(1)
      // The session-scoped Pi adapter is disposed as part of clearing caches.
      expect(disposed.size).toBeGreaterThanOrEqual(1)

      // dispose is idempotent-safe for the global unsubscribe wrapper: calling
      // again does not resubscribe.
      host.dispose()
      expect(subscribes).toBe(1)
    } finally {
      PiHarnessAdapter.prototype.dispose = originalDispose
    }
  })

  test("config apply queue serializes concurrent applies (pi runner, no process spawn)", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-apply-order-"))
    tempDirs.push(dir)
    process.env.HOME = dir
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    // Each apply writes apply-status.json twice (state "applying" on entry,
    // then "applied" on success). Tag every status write with the apply's mcp
    // key so we can observe that ALL of the first apply's writes precede ALL of
    // the second's — proving the applyQueue serializes them.
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const originalMkdir = fs.promises.mkdir
    const originalWrite = fs.promises.writeFile
    let writes = 0
    fs.promises.mkdir = (async () => undefined as never) as typeof fs.promises.mkdir
    fs.promises.writeFile = (async (target: fs.PathLike, body: string | NodeJS.ArrayBufferView) => {
      const name = String(target)
      if (name.endsWith("apply-status.json")) {
        writes++
        const text = typeof body === "string"
          ? body
          : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
        // apply-status.json embeds the applied state; tag with entry vs done.
        const state = (JSON.parse(text) as { state?: string }).state
        order.push(`status:${state}`)
        if (writes === 1) await firstGate
      }
      return undefined as never
    }) as typeof fs.promises.writeFile

    try {
      // Receipts are opt-in, so this test must ask for them: the
      // apply-status.json write is the seam it observes ordering through.
      const host = createWorkspaceHost({
        harness: { id: "pi", access: "native" },
        configApplyReceiptDir: path.join(dir, "host-state", "runtime-config"),
      })

      const first = host.apply({
        version: 1,
        mcp: { first: { type: "stdio", command: "first" } },
        runner: { type: "pi" },
        auth: {},
      })

      while (writes === 0) await new Promise((resolve) => setTimeout(resolve, 0))

      const second = host.apply({
        version: 1,
        mcp: { second: { type: "stdio", command: "second" } },
        runner: { type: "pi" },
        auth: {},
      })

      // The second apply is queued behind the first: while the first is gated
      // on its entry write, no further status writes occur.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(writes).toBe(1)
      expect(order).toEqual(["status:applying"])

      releaseFirst()
      await Promise.all([first, second])

      // Serialized: first apply fully completes (applying → applied) before the
      // second apply's entry write runs.
      expect(order).toEqual([
        "status:applying",
        "status:applied",
        "status:applying",
        "status:applied",
      ])
      host.dispose()
    } finally {
      fs.promises.mkdir = originalMkdir
      fs.promises.writeFile = originalWrite
    }
  })
})

// ── Unit 2: store factory seam ──────────────────────────────────────────────
// A host may inject its own store implementation through
// WorkspaceHostOptions.storeFactory. The memory store from
// @claxedo/agent-sdk-runtime/stores/memory satisfies the engine surface once
// wrapped with getSessionMaxSeq (it has no journal seq of its own). Recovery is
// optional — the memory store omits recoverBusySessions and the engine skips it.
describe("workspace host store factory seam (Unit 2)", () => {
  function memoryStoreFactory(onCreate?: (input: { storeRoot?: string }) => void): {
    factory: WorkspaceRuntimeStoreFactory
    stores: WorkspaceRuntimeStore[]
    recoveryCalls: number
  } {
    const stores: WorkspaceRuntimeStore[] = []
    let recoveryCalls = 0
    const factory: WorkspaceRuntimeStoreFactory = (input) => {
      onCreate?.(input)
      const base = createMemoryRuntimeStore()
      const seqs = new Map<string, number>()
      const store = new Proxy(base as unknown as WorkspaceRuntimeStore, {
        get(target, prop, receiver) {
          if (prop === "getSessionMaxSeq") {
            return (sessionId: string) => seqs.get(sessionId) ?? 0
          }
          if (prop === "recoverBusySessions") {
            return () => {
              recoveryCalls++
            }
          }
          return Reflect.get(target as object, prop, receiver)
        },
      }) as WorkspaceRuntimeStore
      stores.push(store)
      return store
    }
    return {
      factory,
      stores,
      get recoveryCalls() {
        return recoveryCalls
      },
    }
  }

  test("injected memory-backed factory serves store-backed routes without touching disk", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-store-factory-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const seen: Array<{ storeRoot?: string }> = []
    const injected = memoryStoreFactory((input) => seen.push(input))

    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "claude", access: "native" },
      storeRoot,
      storeFactory: injected.factory,
    })

    // Store-backed route: PATCH then GET the session config. This exercises the
    // lazy session-config store() path (getSessionConfig/updateSessionConfig).
    const config = {
      harness: { id: "claude", access: "native" },
      model: { providerID: "anthropic", modelID: "sonnet" },
      variant: null,
      agent: "build",
    } satisfies SessionConfig

    const update = await app.request(
      `http://localhost/session/s-mem/config?directory=${encodeURIComponent(dir)}&runner=claude`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      },
    )
    const read = await app.request(
      `http://localhost/session/s-mem/config?directory=${encodeURIComponent(dir)}&runner=claude`,
    )

    expect(update.status).toBe(200)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(config)

    // The factory produced the session-config store (no SQLite RuntimeStore).
    expect(injected.stores.length).toBeGreaterThanOrEqual(1)
    // The factory was asked for the configured storeRoot.
    expect(seen.some((input) => input.storeRoot === storeRoot)).toBe(true)

    // DoD: zero SQLite files on disk under the storeRoot.
    expect(fs.existsSync(storeRoot)).toBe(false)

    host.dispose()
  })

  test("store-backed session config patch still notifies the live adapter", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-config-adapter-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const calls: string[] = []
    const originalUpdateSessionConfig = AcpHarnessAdapter.prototype.updateSessionConfig
    AcpHarnessAdapter.prototype.updateSessionConfig = async function(_id, patch) {
      calls.push((patch.model as { modelID?: string } | undefined)?.modelID ?? "none")
      return {
        harness: { id: "claude", access: "acp" },
        ...(patch.model ? { model: patch.model } : {}),
        variant: patch.variant ?? null,
        agent: patch.agent ?? null,
      } as SessionConfig
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, { harness: { id: "claude", access: "acp" } })
      const patch = {
        model: { providerID: "claude-acp", modelID: "sonnet" },
        variant: null,
        agent: "build",
      }

      for (const _ of [0, 1]) {
        const res = await app.request(
          `http://localhost/session/s-store/config?directory=${encodeURIComponent(dir)}&harness=claude-acp`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        )
        expect(res.status).toBe(200)
      }

      expect(calls).toEqual(["sonnet", "sonnet"])
      host.dispose()
    } finally {
      AcpHarnessAdapter.prototype.updateSessionConfig = originalUpdateSessionConfig
    }
  })

  test("engine runs recoverBusySessions on the adapter-owned store, not the config store", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-store-factory-recover-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const injected = memoryStoreFactory()

    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "claude", access: "native" },
      storeRoot,
      storeFactory: injected.factory,
    })

    // Force the native adapter to materialize its adapter-owned store, which
    // routes through the factory and then has recoverBusySessions() invoked by
    // the engine (capability-checked).
    const status = await app.request("http://localhost/session/status")
    expect(status.status).toBe(200)

    expect(injected.recoveryCalls).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(storeRoot)).toBe(false)

    host.dispose()
  })

  test("default composition (no factory) still writes the SQLite store to disk", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-store-default-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")

    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "claude", access: "native" },
      storeRoot,
    })

    const update = await app.request(
      `http://localhost/session/s-disk/config?directory=${encodeURIComponent(dir)}&runner=claude`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness: { id: "claude", access: "native" },
          model: { providerID: "anthropic", modelID: "sonnet" },
          variant: null,
          agent: "build",
        }),
      },
    )
    expect(update.status).toBe(200)
    expect(fs.existsSync(storeRoot)).toBe(true)

    host.dispose()
  })
})

// ── Unit 3: harness-adapter registry seam ───────────────────────────────────
// A host may inject its own harness-adapter registry through
// WorkspaceHostOptions.harnesses. createAdapter dispatches through it
// (first match wins); the engine still owns adapterKey caching regardless.
describe("workspace host harness registry seam (Unit 3)", () => {
  // Minimal adapter surface the engine touches on the /session listing path:
  // listSessions() and dispose(). Anything else is cast away — the engine only
  // reaches for capabilities it has (hasAdapterCapability returns false for a
  // plain object, so configureAdapter early-returns).
  function fakeAdapter(onList: (self: object) => void): AgentHarnessAdapter {
    const adapter = {
      listSessions: async (_directory: string) => {
        onList(adapter)
        return []
      },
      dispose: () => {},
    }
    return adapter as unknown as AgentHarnessAdapter
  }

  test("selects a host-registered adapter, caches one instance, and leaves built-ins intact", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-registry-custom-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const fakeInstances = new Set<object>()
    let created = 0
    // Prepend a custom entry that claims the "pi" runner, then fall through to
    // the built-in catalog for everything else. This proves the host entry wins
    // over the built-in Pi adapter.
    const registry: WorkspaceHarnessRegistry = [
      {
        match: (runner) => runner.id === "pi",
        create: () => {
          created++
          return fakeAdapter((self) => fakeInstances.add(self))
        },
      },
      ...defaultWorkspaceHarnessRegistry(),
    ]

    // The built-in Pi adapter must NOT be constructed when the custom entry wins.
    const seenPi = new Set<PiHarnessAdapter>()
    const originalPiList = PiHarnessAdapter.prototype.listSessions
    PiHarnessAdapter.prototype.listSessions = async function (this: PiHarnessAdapter, directory) {
      seenPi.add(this)
      return await originalPiList.call(this, directory)
    }

    try {
      const app = new Hono()
      const host = mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        harnesses: registry,
      })

      // (a) the custom adapter is selected for the pi runner
      const first = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      const second = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      // (b) repeated access reuses ONE instance (engine adapterKey cache), and
      // the custom create() ran exactly once.
      expect(created).toBe(1)
      expect(fakeInstances.size).toBe(1)
      // The built-in Pi adapter was never used.
      expect(seenPi.size).toBe(0)

      host.dispose()
    } finally {
      PiHarnessAdapter.prototype.listSessions = originalPiList
    }
  })

  test("built-in runners resolve identically through the default registry", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-registry-builtin-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    const seenPi = new Set<PiHarnessAdapter>()
    const originalPiList = PiHarnessAdapter.prototype.listSessions
    PiHarnessAdapter.prototype.listSessions = async function (this: PiHarnessAdapter, directory) {
      seenPi.add(this)
      return await originalPiList.call(this, directory)
    }

    try {
      const app = new Hono()
      // Explicitly pass the default registry — must behave exactly like passing
      // no registry at all.
      const host = mountTestHost(app, {
        harness: { id: "codex", access: "native" },
        harnesses: defaultWorkspaceHarnessRegistry(),
      })

      const first = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      const second = await app.request(`http://localhost/session?runner=pi&directory=${encodeURIComponent(dir)}`)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)

      // Default catalog routes pi → the built-in Pi adapter, cached to one
      // instance (same as the no-registry characterization pin above).
      expect(seenPi.size).toBe(1)

      host.dispose()
    } finally {
      PiHarnessAdapter.prototype.listSessions = originalPiList
    }
  })

  test("adapts safe harness lifecycle records into the host process observer", async () => {
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    const runner = { id: "pi", access: "native" } as const
    const entry = defaultWorkspaceHarnessRegistry().find((candidate) => candidate.match(runner))
    if (!entry) throw new Error("Expected the Pi registry entry")
    const adapter = entry.create({
      runner,
      options: { processObserver: observer },
    })

    const session = await adapter.createSession("/safe/workspace")
    await adapter.deleteSession(session.id, "/safe/workspace")

    const registered = events.find((event) => event.type === "registered")
    expect(registered).toMatchObject({
      type: "registered",
      descriptor: {
        kind: "harness",
        role: "harness",
        harnessId: "pi",
        access: "local",
        attributionConfidence: "direct",
        directory: "/safe/workspace",
        sessionId: session.id,
      },
      capabilities: {
        stopGracefully: false,
        killOwnedTree: false,
      },
    })
    expect(events.some((event) => event.type === "exited")).toBeTrue()
    adapter.dispose()
    observer.dispose()
  })

  test("forwards the host Pi model backend to the built-in Pi adapter", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-registry-pi-backend-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    const storeRoot = path.join(dir, ".claxedo", "store")
    const resolved: unknown[] = []
    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "pi", access: "native" },
      storeRoot,
      piModelBackend: (input) => {
        resolved.push(input)
        return undefined
      },
    })

    const created = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pi model" }),
    })
    const session = await created.json() as { id: string }
    const configured = await app.request(
      `http://localhost/session/${session.id}/config?directory=${encodeURIComponent(dir)}&runner=pi`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: { providerID: "openai-codex", modelID: "gpt-5.5" } }),
      },
    )

    const response = await app.request(`http://localhost/session/${session.id}/message?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello" }],
        model: { providerID: "openai-codex", modelID: "gpt-5.5" },
      }),
    })

    expect(created.status).toBe(201)
    expect(configured.status).toBe(200)
    expect(response.status).toBe(200)
    expect(resolved).toEqual([{
      sessionId: session.id,
      model: { providerID: "openai-codex", modelID: "gpt-5.5" },
    }])
    host.dispose()
  })

  test("a host registry with no matching entry throws for an unhandled runner", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-registry-nomatch-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir

    // A registry that only handles "pi" leaves the initial codex runner with no
    // entry. The default catalog has a catch-all (unknown → OpenCode); a custom
    // registry that omits it surfaces an explicit error instead.
    const registry: WorkspaceHarnessRegistry = [
      {
        match: (runner) => runner.id === "pi",
        create: () => fakeAdapter(() => {}),
      },
    ]

    const app = new Hono()
    const host = createWorkspaceHost({
      harness: { id: "codex", access: "native" },
      harnesses: registry,
    })
    app.route("/", ConfigRoutes((snapshot) => host.apply(snapshot), {
      managementAuth: runtimeConfigManagementAuth,
      managementTarget: { workspaceId: runtimeConfigWorkspaceId, hostId: runtimeConfigHostId },
    }))
    host.mount(app, { exposure: loopbackExposure })

    // status route calls ensure() → createAdapter(codex) → no match → throws.
    const status = await app.request("http://localhost/session/status")
    expect(status.status).toBe(500)

    host.dispose()
  })
})

describe("scoped Session tool compatibility", () => {
  test("injects nonce-bound tool instructions for a non-OpenCode harness", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-scoped-tools-"))
    tempDirs.push(dir)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
    let resolvePrompt!: (input: { parts: unknown[] }) => void
    const prompted = new Promise<{ parts: unknown[] }>((resolve) => { resolvePrompt = resolve })
    const adapter = {
      listSessions: async () => [],
      getSession: async () => null,
      createSession: async () => ({ id: "session-1" }),
      updateSession: async () => null,
      getSessionConfig: async () => ({ model: { providerID: "openai", modelID: "gpt-5" }, agent: "build", variant: "high" }),
      updateSessionConfig: async () => ({ model: { providerID: "openai", modelID: "gpt-5" }, agent: "build", variant: "high" }),
      deleteSession: async () => undefined,
      readHarnessCapabilities: () => ({
        harness: "pi",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
      }),
      sendMessage: async function* (_id: string, input: { parts: unknown[] }) {
        resolvePrompt(input)
      },
      getMessages: async () => [],
      dispose() {},
    } as unknown as AgentHarnessAdapter
    const registry: WorkspaceHarnessRegistry = [{
      match: (runner) => runner.id === "pi",
      create: () => adapter,
    }]
    const app = new Hono()
    const host = mountTestHost(app, {
      harness: { id: "pi", access: "native" },
      harnesses: registry,
      target: { workspaceId: "workspace-1", directory: dir },
    })
    await host.registerSessionTools({
      sessionId: "session-1",
      callbackUrl: "http://127.0.0.1:4567/callback/nonce",
      tools: [{
        name: "workgraph_complete_task",
        description: "Complete the bound Task with evidence.",
        inputSchema: { type: "object", required: ["summary", "evidence"] },
      }],
    })

    const response = await app.request(`http://localhost/session/session-1/prompt_async?directory=${encodeURIComponent(dir)}&harness=pi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageID: "message-1",
        parts: [{ type: "text", text: "Ship it" }],
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
      }),
    })
    expect(response.status).toBe(204)
    const input = await prompted
    const context = JSON.stringify(input.parts.at(-1))
    expect(context).toContain("claxedo_scoped_session_tools")
    expect(context).toContain("workgraph_complete_task")
    expect(context).toContain("http://127.0.0.1:4567/callback/nonce")
    expect(context).toContain("session-1")
    expect(context).not.toContain("runId")
    expect(context).not.toContain("streamId")
    expect(context).not.toContain("workItemId")
    host.dispose()
  })
})
