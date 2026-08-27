import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { createLocalApp, type LocalAppOptions } from "./local-app"
import { createLocalDaemonLifecycle } from "./local-daemon-lifecycle"

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
    extensionPolicy: {},
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
    isCredentialPath: (p) => p.startsWith("/api/claxedo/credentials"),
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
})

describe("local composition — health and telemetry", () => {
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
  test("wires the projection tap, ahead of the runtime proxy", () => {
    // STRUCTURAL, not behavioural, and that is a compromise worth naming: the
    // tap only fires on a 2xx from the proxied `/session`, which needs a live
    // workspace and a harness transport this harness does not stand up. Its own
    // behaviour is covered request-level in `session/session-meta-tap.test.ts`.
    //
    // What is checked here is the thing that actually broke: the first version
    // of this composition omitted the tap entirely, and every request-level
    // test above still passed, because the tap adds no route and answers
    // nothing. Position matters equally — the runtime proxy ANSWERS `/session`,
    // so a tap registered after it never sees the call and the session list
    // silently stops filling.
    const source = readFileSync(new URL("./local-app.ts", import.meta.url), "utf8")
    const tap = source.indexOf("app.use(sessionMetaProjectionTap(")
    const proxy = source.indexOf("app.use(createWorkspaceRuntimeProxy(")

    expect(tap, "the composition must record local session metadata").toBeGreaterThan(-1)
    expect(proxy, "the composition must mount the workspace runtime proxy").toBeGreaterThan(-1)
    expect(tap, "the tap must be registered BEFORE the runtime proxy").toBeLessThan(proxy)
  })
})
