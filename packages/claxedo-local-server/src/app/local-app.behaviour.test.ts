import { CLAXEDO_MCP_TOOL_GROUP_IDS } from "@claxedo/mcp"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono, type Context, type Next } from "hono"
import { customVerifierAuthAdapter, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { claxedoBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import type { McpClientInputs } from "@claxedo/mcp"
import {
  createTestBackend,
  setBackendOverride,
} from "@claxedo/server-core/credentials/backend-registry"
import { putCredential, setActiveCredentials } from "@claxedo/server-core/credentials/registry"
import { createLocalCredentialBroker } from "../credentials/broker"
import { providerProjection } from "@claxedo/agent-sdk-runtime"
import { createLocalApp, type LocalAppOptions } from "./local-app"
import { createLocalDaemonLifecycle } from "./local-daemon-lifecycle"

/**
 * What the workspace runtime proxy answers in place of a runtime, for the one
 * test that needs it to answer at all. Creating a session in the embedded
 * runtime resolves a harness adapter, which this fixture does not stand up.
 */
const runtimeAnswer = vi.hoisted(() => ({ current: undefined as ((request: Request) => Response | undefined) | undefined }))
vi.mock("../workspace/runtime-dispatch/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/runtime-dispatch/middleware")>()
  return {
    ...actual,
    createWorkspaceRuntimeProxy: (options?: Parameters<typeof actual.createWorkspaceRuntimeProxy>[0]) => {
      const proxy = actual.createWorkspaceRuntimeProxy(options)
      return (c: Context, next: Next) => runtimeAnswer.current?.(c.req.raw) ?? proxy(c, next)
    },
  }
})

/**
 * Request-level, because the route-inventory contract cannot see any of this.
 *
 * A first version of this composition passed a path-level contract test with
 * six divergences from the self-hosted composition it copies — a CORS widening,
 * a dropped credential-auth fallback, a missing fail-fast, an absent
 * session-meta tap, and two weakened endpoints. Not one of them changes the
 * registered route table, so the inventory test would have passed unchanged if
 * every one were introduced or reversed.
 *
 * Each test below sends a request and asserts on the response or on a recorded
 * side effect. One per finding.
 */

let dataDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-local-app-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE", "CLAXEDO_SIGNED_CLOUD_AUTH", "CLAXEDO_CREDENTIALS_TOKEN"]) {
    saved[key] = process.env[key]
  }
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function services(overrides: Record<string, unknown> = {}) {
  return {
    auth: localOnlyAuthAdapter(),
    credentials: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async () => ({ id: "cred_1" }),
      deleteCredential: async () => true,
      deleteCredentialsByProvider: async () => 0,
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    },
    localExecution: { enabled: true },
    telemetry: { capture: vi.fn() },
    projectionStore: {
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      list_session_metas: vi.fn(async () => []),
      list_session_navigation_metas: vi.fn(async () => []),
    },
    relay: {},
    sandbox: {},
    durableSessionLog: {},
    ...overrides,
  } as unknown as LocalAppOptions["services"]
}

function app(overrides: Partial<LocalAppOptions> = {}) {
  return createLocalApp({
    services: services(),
    corsOrigin: (origin) => origin,
    ...overrides,
  }).app
}

describe("local composition — CORS", () => {
  test("never grants credentialed cross-origin reads", async () => {
    // The self-hosted composition never sets `credentials: true`, so even an
    // origin its policy approves cannot complete a `credentials: 'include'`
    // fetch. Setting it here would widen that structurally.
    const response = await app().request("http://localhost/api/claxedo/health", {
      headers: { Origin: "http://localhost:4444" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4444")
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  test("reflects no origin at all for credential-bearing paths", async () => {
    // The header defense relies on the browser blocking the cross-origin READ,
    // which it only does when no ACAO comes back.
    const response = await app().request("http://localhost/api/claxedo/credentials", {
      headers: { Origin: "http://localhost:4444" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("withholds it from the broker's binding paths under the same rule", async () => {
    // The broker spends the operator's stored key at the vendor, so an ACAO
    // here would let a loopback page do the spending.
    const response = await app({ egressBroker: async () => new Response(null, { status: 401 }) })
      .request("http://127.0.0.1/bindings/b1/v1/messages", {
        headers: { Origin: "http://localhost:4444" },
      })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("local composition — credential routes", () => {
  test("require a bearer token on a signed box, without the caller asking", async () => {
    // Derived from the environment, exactly as the self-hosted composition
    // derives it. The first version made this a caller-supplied hook with no
    // fallback, so a caller that omitted it left credential mutation behind
    // only the loopback guard.
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"

    const response = await app().request("http://localhost/api/claxedo/credentials", { method: "GET" })

    expect(response.status).toBe(401)
  })

  test("stay open on an unsigned loopback box", async () => {
    delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    const response = await app().request("http://localhost/api/claxedo/credentials", { method: "GET" })

    expect(response.status).toBe(200)
  })

  test("read the signed caller's own org, not the single-tenant partition", async () => {
    // The composition's auth adapter is what resolves the tenant. Mounted
    // without it, every signed caller is answered in `__local__` and sees
    // another org's accounts.
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    const listCredentials = vi.fn(async (_org: string) => [])
    const instance = createLocalApp({
      services: services({
        auth: customVerifierAuthAdapter({
          issuer: "https://idp.example.test",
          verifier: async (token, config) => ({
            mode: "signed" as const,
            user: {
              subject: token,
              tokenIdentifier: `${config.issuer}|${token}`,
              issuer: config.issuer,
              orgId: "org-alpha",
            },
          }),
        }),
        credentials: { listCredentials },
      }),
    }).app

    const response = await instance.request("http://localhost/api/claxedo/credentials", {
      headers: { Authorization: "Bearer alpha-user" },
    })

    expect(response.status).toBe(200)
    expect(listCredentials).toHaveBeenCalledWith("org-alpha")
  })
})

describe("local composition — sandbox driver settings", () => {
  test("serves the provider catalog at the renderer's hosted-compatible path", async () => {
    const response = await app().request("http://localhost/api/workspace/drivers")
    expect(response.status).toBe(200)

    const body = await response.json() as {
      default_driver?: string
      drivers?: Array<{ id: string; label: string; fields: unknown[] }>
    }

    expect(body.default_driver).toBe("daytona")
    expect(body.drivers?.map((driver) => driver.id)).toEqual([
      "exe",
      "daytona",
      "modal",
      "vercel",
      "cloudflare",
      "box",
    ])
    expect(body.drivers?.every((driver) => driver.label && driver.fields.length > 0)).toBe(true)
  })
})

describe("local composition — health and telemetry", () => {
  test("serves the dedicated control-plane event stream", async () => {
    const controller = new AbortController()
    const response = await app().request("http://127.0.0.1/api/claxedo/events", {
      signal: controller.signal,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("local-event-stream-probe")) {
      const next = await reader.read()
      if (next.done) break
      received += decoder.decode(next.value, { stream: true })
      if (!received.includes("local-event-stream-probe")) {
        claxedoBus.publish({
          type: "document.changed",
          documentId: "local-event-stream-probe",
          orgId: "local-test-org",
          projectId: "local-test-project",
          ts: 1,
        })
      }
    }
    controller.abort()

    expect(received).toContain('"type":"document.changed"')
    expect(received).toContain("local-event-stream-probe")
    expect(received).not.toContain('"payload":{"type":"document.changed"')
  }, 10_000)

  test("disabled composition does not own the optional Agent Plugins API", async () => {
    const local = app()
    expect((await local.request("http://localhost/api/claxedo/plugins")).status).toBe(404)
  })

  test("health reports the fields the shell reads", async () => {
    const body = await (await app().request("http://localhost/api/claxedo/health")).json() as Record<string, unknown>

    expect(body).toMatchObject({ ok: true, localExecution: true })
    expect(body).toHaveProperty("harnessMode")
    expect(body).toHaveProperty("workspaceProfile")
  })

  test("daemon identity is absent unless the process explicitly owns one", async () => {
    expect((await app().request("http://localhost/api/claxedo/daemon")).status).toBe(404)
  })

  test("daemon identity requires its installation token", async () => {
    const identity = {
      token: "installation-secret",
      protocol: 1,
      generation: "generation-1",
      pid: 42,
    }
    const onIdle = vi.fn()
    const lifecycle = createLocalDaemonLifecycle({
      activity: () => ({
        pty: { running: 0, committed: 0, provisional: 0, managed: 0, subscribers: 0 },
        runtime: { hosts: 0, activeTurns: 0, activeWrites: 0, checkpointing: 0 },
        residencyPins: 0,
        replacementBlockers: 0,
      }),
      onIdle,
    })
    lifecycle.start()
    const local = app({ daemon: { identity, lifecycle } })

    expect((await local.request("http://localhost/api/claxedo/daemon")).status).toBe(401)
    expect((await local.request("http://localhost/api/claxedo/daemon", {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401)

    const response = await local.request("http://localhost/api/claxedo/daemon", {
      headers: { authorization: "Bearer installation-secret" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      service: "claxedo-local-daemon",
      protocol: 1,
      generation: "generation-1",
      pid: 42,
    })

    const acquired = await local.request("http://localhost/api/claxedo/daemon/leases", {
      method: "POST",
      headers: { authorization: "Bearer installation-secret" },
    })
    expect(acquired.status).toBe(201)
    const lease = await acquired.json() as { id: string }
    expect((await local.request(`http://localhost/api/claxedo/daemon/leases/${lease.id}`, {
      method: "PUT",
      headers: { authorization: "Bearer installation-secret" },
    })).status).toBe(200)
    expect(await (await local.request(`http://localhost/api/claxedo/daemon/leases/${lease.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer installation-secret" },
    })).json()).toEqual({ released: true })

    const replacementLease = await (await local.request("http://localhost/api/claxedo/daemon/leases", {
      method: "POST",
      headers: { authorization: "Bearer installation-secret" },
    })).json() as { id: string }
    expect((await local.request("http://localhost/api/claxedo/daemon/shutdown", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
      },
      body: JSON.stringify({ leaseId: replacementLease.id }),
    })).status).toBe(401)
    expect((await local.request("http://localhost/api/claxedo/daemon/shutdown", {
      method: "POST",
      headers: {
        authorization: "Bearer installation-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })).status).toBe(400)
    expect(await (await local.request("http://localhost/api/claxedo/daemon/shutdown", {
      method: "POST",
      headers: {
        authorization: "Bearer installation-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ leaseId: replacementLease.id }),
    })).json()).toEqual({ shutdownRequested: true, released: true })
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("telemetry rejects a body that does not match the schema", async () => {
    const capture = vi.fn()
    const response = await app({ services: services({ telemetry: { capture } }) }).request(
      "http://localhost/api/claxedo/track",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `properties` must be a record; an array is not one.
        body: JSON.stringify({ distinctId: "d", event: "e", properties: ["nope"] }),
      },
    )

    expect(response.status).toBe(400)
    expect(capture).not.toHaveBeenCalled()
  })

  test("telemetry forwards a valid body", async () => {
    const capture = vi.fn()
    const response = await app({ services: services({ telemetry: { capture } }) }).request(
      "http://localhost/api/claxedo/track",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ distinctId: "d", event: "e", properties: { a: 1 } }),
      },
    )

    expect(response.status).toBe(200)
    expect(capture).toHaveBeenCalledWith("d", "e", { a: 1 })
  })
})

describe("local composition — optional route contributions", () => {
  test("mounts no agent-plugin route unless the product explicitly contributes it", async () => {
    expect((await app().request("http://localhost/api/claxedo/agent-plugins")).status).toBe(404)
  })

  test("mounts a supplied contribution through the generic composition seam", async () => {
    const routes = new Hono().get("/", (c) => c.json({ feature: "agent-plugins" }))
    const response = await app({
      routeContributions: [{ id: "agent-plugins", path: "/api/claxedo/agent-plugins", routes }],
    }).request("http://localhost/api/claxedo/agent-plugins")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ feature: "agent-plugins" })
  })
})

describe("local composition — shell invariants", () => {
  test("refuses to compose without local execution", () => {
    expect(() => app({ services: services({ localExecution: { enabled: false } }) }))
      .toThrow(/requires localExecution/)
  })

  test("stamps security headers on every response, including a 404", async () => {
    const response = await app().request("http://localhost/nothing-here")

    expect(response.status).toBe(404)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })
})

describe("local composition — workspace registration", () => {
  test("resolves and registers a local directory through the control-plane route", async () => {
    const directory = path.join(dataDir, "project")
    mkdirSync(directory)
    execFileSync("git", ["init", directory])
    // .native expands Windows 8.3 short names (RUNNER~1 -> runneradmin) the
    // way the product's resolution does; the JS realpath does not.
    const canonicalDirectory = realpathSync.native(directory)
    const response = await app().request(
      `http://localhost/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: canonicalDirectory,
      projectId: expect.any(String),
      workspaceId: expect.any(String),
      kind: "local",
      access: "local",
      backing: {
        kind: "local-worktree",
        directory: canonicalDirectory,
      },
    })
  })
})

describe("local composition — session inventory", () => {
  test("serves the local projection at the local inventory route", async () => {
    const response = await app().request("http://localhost/api/claxedo/session")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: [] })
  })

  test("serves the paginated local session-list contract used by the rail", async () => {
    const response = await app().request(
      "http://localhost/api/claxedo/session-list?scope=workspace&directory=C%3A%5Cworkspace&limit=50",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 50 },
      items: [],
      totalKnown: 0,
    })
  })
})

describe("local composition — session metadata recording", () => {
  afterEach(() => {
    runtimeAnswer.current = undefined
  })

  test("records the session the runtime proxy answers with", async () => {
    // The proxy answers `POST /session` itself, so a tap registered after it
    // never sees the response and the session list silently stops filling.
    runtimeAnswer.current = (request) =>
      request.method === "POST" && new URL(request.url).pathname === "/session"
        ? Response.json({ id: "ses_1", title: "First", directory: "/work" })
        : undefined
    const composed = services()
    const response = await app({ services: composed }).request("http://localhost/session?directory=%2Fwork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(composed.projectionStore.put_session_meta).toHaveBeenCalledTimes(1)
    expect(composed.projectionStore.put_session_meta).toHaveBeenCalledWith("ses_1", expect.objectContaining({
      title: "First",
      directory: "/work",
    }))
  })
})

describe("local composition — first-party MCP", () => {
  const claims = { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1", expiresAt: Number.MAX_SAFE_INTEGER }
  let directory: string
  beforeEach(async () => {
    directory = realpathSync(dataDir)
    execFileSync("git", ["init"], { cwd: directory, stdio: "pipe" })
    const workspace = await ensureWorkspace({ directory })
    if (!workspace) throw new Error("The fixture workspace was not created")
    claims.workspaceId = workspace.id
  })

  const stubClient: ClaxedoMcpClient = {
    deployment: "loopback",
    runtime: async () => async () => new Response(null, { status: 204 }),
    resolveTarget: async () => ({ kind: "loopback", baseUrl: "", headers: {} }),
    server: () => Promise.reject(new Error("unused")),
    workspaces: async () => [],
  }
  const initialize = (built: Hono, headers: Record<string, string> = {}) =>
    built.request("http://localhost/api/claxedo/mcp?session=ses_1", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "0" } },
      }),
    })

  test("is absent unless the composition supplies the runtime credential verifier", async () => {
    expect((await initialize(app(), { authorization: "Bearer rt" })).status).toBe(404)
  })

  test("admits the runtime credential and hands the client factory this app's fetch for that workspace", async () => {
    const inputs: McpClientInputs[] = []
    const echo = new Hono().get("/", (c) => c.json({ workspace: c.req.header("x-workspace-id") ?? null }))
    const built = app({
      routeContributions: [{ id: "echo", path: "/api/claxedo/echo", routes: echo }],
      firstPartyMcp: {
        enabledToolGroups: () => CLAXEDO_MCP_TOOL_GROUP_IDS,
        verifyRuntimeCredential: (token) => (token === "rt" ? claims : undefined),
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })

    expect((await initialize(built)).status).toBe(401)
    const response = await initialize(built, { authorization: "Bearer rt" })
    expect(response.status).toBe(200)
    expect(response.headers.get("mcp-session-id")).toMatch(/\S/)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      deployment: "loopback",
      credential: { kind: "runtime", runtimeId: "rt_1", workspaceId: claims.workspaceId, sessionId: "ses_1" },
      local: { workspace: { workspaceId: claims.workspaceId, directory } },
    })
    expect(inputs[0]?.controlPlane).toBeUndefined()
    expect(inputs[0]?.documents).toBeDefined()
    const local = inputs[0]?.local
    if (!local) throw new Error("the loopback mount composed no runtime client")
    expect(await (await local.fetch("/api/claxedo/echo")).json()).toEqual({ workspace: claims.workspaceId })
  })

  test("hands the client every Tasks operation over this same app, confined to no project", async () => {
    const inputs: McpClientInputs[] = []
    const built = app({
      routeContributions: [{ id: "echo", path: "/api/claxedo/echo", routes: new Hono().get("/", (c) => c.text("ok")) }],
      firstPartyMcp: {
        enabledToolGroups: () => CLAXEDO_MCP_TOOL_GROUP_IDS,
        verifyRuntimeCredential: (token) => (token === "rt" ? claims : undefined),
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })

    expect((await initialize(built, { authorization: "Bearer rt" })).status).toBe(200)
    const tasks = inputs[0]?.tasks
    if (!tasks) throw new Error("the loopback mount composed no Tasks grant")
    expect(tasks.operations).toEqual(["read", "create", "start"])
    // No project: this machine's own workspace answers that question, and a
    // grant that named one would confine the local agent for no reason.
    expect(tasks.projectId).toBeUndefined()
    expect(await (await tasks.fetch("/api/claxedo/echo")).text()).toBe("ok")
  })

  test("reflects no CORS origin on the MCP route even for an origin the shell admits", async () => {
    const built = app({
      firstPartyMcp: { enabledToolGroups: () => CLAXEDO_MCP_TOOL_GROUP_IDS, verifyRuntimeCredential: () => claims, createClient: () => stubClient },
    })
    const headers = { origin: "http://localhost:5173", authorization: "Bearer rt" }
    const shell = await built.request("http://localhost/api/claxedo/health", { headers })
    expect(shell.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    const mcp = await initialize(built, headers)
    expect(mcp.status).toBe(200)
    expect(mcp.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("local egress broker hosting", () => {
  test("uses broker authentication without granting browser CORS access", async () => {
    const verifyToken = vi.fn(async (_token: string) => undefined)
    const instance = app({ egressBroker: async (request) => {
      await verifyToken(request.headers.get("authorization")!.slice(7))
      return new Response(null, { status: 401 })
    } })
    const response = await instance.request("http://127.0.0.1/bindings/b1/v1/messages", {
      headers: { Authorization: "Bearer invalid-runtime-token", Origin: "http://localhost:3000" },
    })
    expect(response.status).toBe(401)
    expect(verifyToken).toHaveBeenCalledWith("invalid-runtime-token")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("rejects a non-loopback request before verifying its token", async () => {
    const verifyToken = vi.fn(async (_token: string) => undefined)
    const instance = app({ egressBroker: async (request) => {
      await verifyToken(request.headers.get("authorization")!.slice(7))
      return new Response(null, { status: 401 })
    } })
    const response = await instance.request("https://remote.example/bindings/b1/v1/messages", {
      headers: { Authorization: "Bearer invalid-runtime-token" },
    })
    expect(response.status).toBe(403)
    expect(verifyToken).not.toHaveBeenCalled()
  })

  test("names its own refusal in a code the harness can read", async () => {
    // Signed, so the composition's unsigned-local guard passes the request
    // through and the broker mount is the one that answers. On an unsigned box
    // that guard refuses first, under `unsigned_local_loopback_required`.
    const instance = app({
      egressBroker: async () => new Response(null, { status: 401 }),
      services: services({
        auth: customVerifierAuthAdapter({
          issuer: "https://idp.example.test",
          verifier: async (token, config) => ({
            mode: "signed" as const,
            user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
          }),
        }),
      }),
    })

    const response = await instance.request("https://remote.example/bindings/b1/v1/messages", {
      headers: { Authorization: "Bearer runtime-token" },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: { code: "loopback_required", message: "The credential broker answers loopback callers only" },
    })
  })
})

describe("local egress broker — the mounted authority", () => {
  const upstreamValue = "sk-ant-api03-real-stored-value"

  /** A real authority over a real registry row, mounted on a real local app. */
  async function mounted() {
    setBackendOverride(createTestBackend())
    const credential = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-mounted",
      secret: upstreamValue,
    })
    expect(setActiveCredentials([credential.id])).toMatchObject({ ok: true })
    const local = createLocalCredentialBroker({ dataDir, brokerOrigin: "http://127.0.0.1" })
    // Read the way a runtime reads it, so the placeholder here is the one a
    // harness would actually present.
    const row = providerProjection((await local.projectAuth({ workspaceId: "ws-mounted" }))["claude-sdk"], {})
    if (!row) throw new Error("expected a valid projection")
    if ("unavailable" in row) throw new Error(`expected a bound projection, got ${row.reason}`)
    return {
      instance: app({ egressBroker: local.handler }),
      projection: row,
      bindingId: row.baseUrl.slice("http://127.0.0.1/bindings/".length),
    }
  }

  test("refuses a request that carries no runtime token", async () => {
    const { instance, bindingId } = await mounted()
    const response = await instance.request(`http://127.0.0.1/bindings/${bindingId}/v1/messages`, { method: "POST" })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "runtime_token_required" } })
  })

  test("refuses a valid token presented at a binding it does not name", async () => {
    const { instance, projection } = await mounted()
    const response = await instance.request("http://127.0.0.1/bindings/deadbeefdeadbeef/v1/messages", {
      method: "POST",
      headers: { "x-api-key": projection.placeholder },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "binding_not_permitted" } })
  })

  test("attaches the stored value at the vendor and streams the answer back", async () => {
    const { instance, projection, bindingId } = await mounted()
    const upstream: Request[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstream.push(new Request(url, init))
      return new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch
    try {
      const response = await instance.request(`http://127.0.0.1/bindings/${bindingId}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": projection.placeholder, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude" }),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("data: hello\n\n")
      expect(upstream[0]?.url).toBe("https://api.anthropic.com/v1/messages")
      expect(upstream[0]?.headers.get("x-api-key")).toBe(upstreamValue)
      expect(projection.placeholder).not.toContain(upstreamValue)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("refuses a non-loopback peer before the authority is consulted", async () => {
    const { instance, projection, bindingId } = await mounted()
    const response = await instance.request(`https://remote.example/bindings/${bindingId}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": projection.placeholder },
    })

    expect(response.status).toBe(403)
    // The composition's own unsigned-local guard answers first; the broker
    // mount's loopback check is the second of the two, never the only one.
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unsigned_local_loopback_required" } })
  })
})
