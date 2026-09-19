import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { createSelfHostedApp } from "./app"
import { DuplicateRouteOwner, withRouteOwnership } from "../route-ownership"
import { createControlPlaneServices } from "../../authority/services"
import { customVerifierAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import type { McpClientInputs } from "@claxedo/mcp"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "@claxedo/local-server/self-hosted-execution"

/**
 * Who owns what in the self-hosted composition.
 *
 * `createSignedControlPlaneApp` has recorded its mounts since the hosted/shared
 * split; this is the second composition to do it, and the two ledgers are what
 * make a combined app checkable instead of order-dependent.
 *
 * What the guard does and does not buy here is worth being exact about, because
 * a guard believed to cover more than it does is worse than none. Inside one
 * composition there is one owner, and `createRouteOwnership` deliberately lets
 * an owner re-claim its own prefix — `/api/workspace` carries both
 * `WorkspaceRoutes` and `WorkspaceCheckpointRoutes` on purpose. So this does
 * NOT catch a duplicate written inside `createSelfHostedApp`. It catches a
 * SECOND composition mounting onto the same app, which is the arrangement the
 * package split creates and the one Hono resolves silently by call order.
 */

let dataDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  savedDataDir = process.env.CLAXEDO_DATA_DIR
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-ownership-"))
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = savedDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function selfHosted(options: Parameters<typeof createSelfHostedApp>[1] = {}, signed = false) {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      {
        authority: testManagedSessionAuthority(),
        localExecution: { enabled: true },
        telemetry: { capture: () => {} },
        ...(signed
          ? {
              auth: customVerifierAuthAdapter({
                issuer: "https://idp.example.test",
                verifier: async (token, config) => ({
                  mode: "signed" as const,
                  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
                }),
              }),
            }
          : {}),
      },
    ),
    options,
  )
}

/**
 * Every prefix `createSelfHostedApp` claims, measured from the composition.
 *
 * Committed rather than derived so that a new mount point — including one added
 * by a `mount*` helper that runs against this app, such as the channels
 * ingress — is a line in a diff. The owner is uniform today; it stops being
 * uniform the moment a shared core is composed in, and that is the change this
 * table is here to make visible.
 */
const SELF_HOSTED_MOUNTS = [
  { prefix: "/", owner: "self-hosted-node" },
  { prefix: "/api/channels", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/agent-config", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/credentials", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/host/enrollments", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/host/invitations", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/integrations", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/network-policy", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/project", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/projects", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/remote-access", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/workspace", owner: "self-hosted-node" },
  { prefix: "/api/control", owner: "self-hosted-node" },
  { prefix: "/api/control/session-registrations", owner: "self-hosted-node" },
  { prefix: "/api/runtime-authority", owner: "self-hosted-node" },
  { prefix: "/api/workspace", owner: "self-hosted-node" },
  { prefix: "/documents", owner: "self-hosted-node" },
  { prefix: "/internal/documents", owner: "self-hosted-node" },
]

describe("the self-hosted route ledger", () => {
  test("records every mount the composition makes", () => {
    expect(selfHosted().routeOwnership.mounts()).toEqual(SELF_HOSTED_MOUNTS)
  })

  test("the ledger is filled by composing, not by the table above", () => {
    // Positive control. `mounts()` returning [] would satisfy a subset check
    // and would satisfy every "does not collide" assertion below.
    const built = selfHosted()

    expect(built.routeOwnership.owner("/api/workspace")).toBe("self-hosted-node")
    expect(built.routeOwnership.owner("/api/claxedo/never-mounted")).toBeUndefined()
  })
})

describe("the first-party MCP on the self-hosted node", () => {
  const stubClient: ClaxedoMcpClient = {
    deployment: "node",
    runtime: async () => async () => new Response(null, { status: 204 }),
    resolveTarget: async () => ({ kind: "node", baseUrl: "", headers: {} }),
    server: () => Promise.reject(new Error("unused")),
    workspaces: async () => [],
  }

  test("is a contribution under its own owner, and only when the composition supplies it", async () => {
    expect(selfHosted().routeOwnership.owner("/api/claxedo/mcp")).toBeUndefined()
    const built = selfHosted({ firstPartyMcp: { createClient: () => stubClient } })
    expect(built.routeOwnership.owner("/api/claxedo/mcp")).toBe("feature:claxedo-mcp")
  })

  test("admits the unsigned loopback caller as the box's anonymous account and serves this box's runtimes in-process", async () => {
    const inputs: McpClientInputs[] = []
    const built = selfHosted({
      firstPartyMcp: {
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })
    const response = await built.app.request("http://127.0.0.1/api/claxedo/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli", version: "0" } },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("mcp-session-id")).toMatch(/\S/)
    expect(inputs[0]).toMatchObject({
      deployment: "node",
      credential: { kind: "user", actorId: "loopback", clientId: "loopback", readOnly: false },
      local: { workspace: {} },
    })
    const controlPlane = inputs[0]?.controlPlane
    if (!controlPlane) throw new Error("the node mount composed no control-plane client")
    expect(await (await controlPlane.fetch("/api/claxedo/health")).json()).toMatchObject({ ok: true })
  })
})

describe("the guard on the composed app", () => {
  test("refuses a second composition claiming a prefix this one owns", () => {
    // The real failure being prevented: a shared signed core mounted onto the
    // self-hosted app would shadow, or be shadowed by, whichever ran first.
    const built = selfHosted()

    expect(() =>
      withRouteOwnership(built.app, built.routeOwnership, "shared-signed-core").route(
        "/api/workspace",
        new Hono() as never,
      ),
    ).toThrow(DuplicateRouteOwner)
  })

  test("names both compositions, because the fix has to know which mount to drop", () => {
    const built = selfHosted()

    expect(() =>
      withRouteOwnership(built.app, built.routeOwnership, "shared-signed-core").route(
        "/documents",
        new Hono() as never,
      ),
    ).toThrow(/self-hosted-node.*shared-signed-core/)
  })

  test("still lets this composition mount twice under one prefix", () => {
    // `/api/workspace` already carries two route objects. A rule that failed
    // on that would break a working composition to enforce a rule about a
    // different problem.
    const built = selfHosted()

    expect(() => built.app.route("/api/workspace", new Hono() as never)).not.toThrow()
  })

  test("the guard is installed on the app the composition returns, not a copy", async () => {
    // Positive control for the three assertions above: they would all hold on
    // a bare Hono that had never been wrapped, which is exactly what an
    // accidentally-unwrapped composition returns.
    const built = selfHosted()

    expect(await (await built.app.request("/api/claxedo/health")).json()).toMatchObject({ ok: true })
    built.app.route("/api/claxedo/probe", new Hono() as never)
    expect(built.routeOwnership.owner("/api/claxedo/probe")).toBe("self-hosted-node")
  })
})

describe("the host aggregate on the self-hosted node", () => {
  // This node hosts its local workspaces' runtimes in-process, so a browser on
  // it opens one `wr/events` naming no workspace and expects every mounted
  // runtime's frames on it. Mounted through the runtime proxy rather than as a
  // route, so the stream-route ledger below still sees only `/api/cp/events`.
  test("answers a loopback-direct wr/events naming no workspace", async () => {
    const built = selfHosted()
    const abort = new AbortController()
    const response = await built.app.request("http://127.0.0.1/api/wr/events", { signal: abort.signal })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/)

    // The bootstrap heartbeat carries the resume cursor and is written before
    // the fanout attaches, so it arrives with no runtime mounted.
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    await reader.cancel().catch(() => {})

    expect(first).toContain('data: {"type":"heartbeat"}')
    // The id is the ring's own position, numbered from the clock so a cursor
    // from a previous process reads as a gap rather than as a position here.
    expect(first).toMatch(/\nid: \d+\n/)
  })

  test("refuses a relay-stamped wr/events: the aggregate is a loopback-direct reader's", async () => {
    const built = selfHosted()
    const response = await built.app.request("http://127.0.0.1/api/wr/events", {
      headers: { [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify({ actor_id: "actor_1" }) },
    })

    expect(response.status).toBe(403)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("host_event_stream_denied")
  })

  test("a signed node mounts no aggregate: the request falls through instead of 403ing forever", async () => {
    const built = selfHosted({}, true)
    const response = await built.app.request("http://127.0.0.1/api/wr/events")

    expect(response.headers.get("content-type")).not.toMatch(/text\/event-stream/)
    expect(response.status).toBe(404)
  })

  // The browser cannot tell the two postures apart from the URL — this node's
  // issuer runs on localhost as well — so the bootstrap states it. Read from
  // the composed app rather than from the flag, because a declaration computed
  // beside the mount and a declaration computed from the same expression twice
  // are not the same guarantee.
  test("the bootstrap declares exactly what the runtime proxy serves, in both postures", async () => {
    for (const signed of [false, true]) {
      const built = selfHosted({}, signed)

      const bootstrap = await built.app.request("http://127.0.0.1/api/claxedo/bootstrap")
      expect(bootstrap.status).toBe(200)
      const declared = (await bootstrap.json() as { events?: { hostAggregate?: boolean } }).events?.hostAggregate

      const abort = new AbortController()
      const stream = await built.app.request("http://127.0.0.1/api/wr/events", { signal: abort.signal })
      const served = /text\/event-stream/.test(stream.headers.get("content-type") ?? "")
      abort.abort()
      await stream.body?.cancel().catch(() => {})

      expect(served, `signed=${signed}`).toBe(declared)
      expect(declared, `signed=${signed}`).toBe(!signed)
    }
  })
})

describe("the control plane's notice stream", () => {
  // `withRouteOwnership` above catches a second COMPOSITION claiming a prefix
  // another one owns; it does not see two handlers for one exact path inside
  // a single composition. `ShellRoutes` owns `/api/cp/events`, and Hono
  // resolves the first-registered handler for an exact path, so this
  // composition must register no other handler for it — and no other
  // stream route at all: a session's frames are its workspace runtime's.
  test("exactly one stream handler is registered, for GET /api/cp/events", () => {
    const built = selfHosted()

    const streams = built.app.routes.filter(
      (route) => route.method === "GET" && /event/.test(route.path),
    )
    expect(streams.map((route) => route.path)).toEqual(["/api/cp/events"])
  })
})
