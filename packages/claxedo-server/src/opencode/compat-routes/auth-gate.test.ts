import { afterAll, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Point the data dir at a temp root BEFORE importing the route module: it pulls
// in ClaxedoDB via workspace-store, which opens (and migrates) the database on
// first use. Same idiom as control-plane-route-auth.test.ts.
const root = path.join(realpathSync(os.tmpdir()), `opencode-compat-auth-gate-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
mkdirSync(root, { recursive: true })
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { OpenCodeCompatRoutes } = await import("@claxedo/local-server/opencode/compat-routes/index")
const { ControlPlaneAuthError } = await import("@claxedo/server-core/platform/auth/auth")
const { RouteHandler, routeOwnership } = await import("@claxedo/server-core/platform/governance/route-ownership")
type ControlPlaneAuthConfig = import("@claxedo/server-core/platform/auth/auth").ControlPlaneAuthConfig
type ClerkVerifier = import("@claxedo/server-core/platform/auth/auth").ClerkVerifier

afterAll(async () => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

// OpenCodeCompatRoutes was mounted with no auth options at all. The only gate
// was the global `unsignedLocalRequestGuard`, which `return next()`s the moment
// `authConfig.enabled` — and self-host boxes enable signed auth
// (`CLAXEDO_EMBEDDED_AUTH=1`) precisely so they can be reached remotely. That
// left this router's whole surface unauthenticated from off-box on a signed
// box, including `DELETE /experimental/worktree` (`fs.rm` recursive+force),
// `POST /experimental/worktree/reset` (`git reset --hard` + `git clean -ffdx`),
// `PUT|DELETE /auth/:providerID` (credential write/delete), `PATCH /config` and
// `PATCH /global/config` (MCP server definitions) and `GET /file/content`
// (arbitrary file read). See control-plane-route-auth.ts for the pattern.

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

// The local desktop posture: signed auth off, loopback-only. The gate must stay
// out of the way here — this is the common case and the whole point of
// `unsignedLocalRequestGuard`.
const unsignedLocalConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
}

const GOOD_TOKEN = "valid-bearer"

const verifier: ClerkVerifier = async (token) => {
  if (token !== GOOD_TOKEN) {
    throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
  }
  return {
    mode: "signed",
    user: {
      subject: "user_1",
      tokenIdentifier: "https://example.clerk.dev|user_1",
      issuer: signedConfig.issuer as string,
    },
  }
}

function signedApp() {
  return new Hono().route("/", OpenCodeCompatRoutes({ authConfig: signedConfig, verifier }))
}

function unsignedLocalApp() {
  return new Hono().route("/", OpenCodeCompatRoutes({ authConfig: unsignedLocalConfig }))
}

/**
 * Every method/path the compat router actually exposes, read off its own route
 * table so a route added later cannot quietly join an already-passing suite.
 * The gate itself registers as method `ALL`, so filtering it out leaves exactly
 * the handler routes.
 */
function compatSurfaces(): Array<[string, string]> {
  const seen = new Set<string>()
  const surfaces: Array<[string, string]> = []
  for (const route of OpenCodeCompatRoutes().routes) {
    if (route.method === "ALL") continue
    const concrete = route.path
      .replace(":providerID", "anthropic")
      .replace(":name", "some-mcp")
      .replace(":step", "authorize")
      .replace(":id", "project_1")
    const key = `${route.method} ${concrete}`
    if (seen.has(key)) continue
    seen.add(key)
    surfaces.push([route.method, concrete])
  }
  return surfaces
}

const SURFACES = compatSurfaces()

function requestInit(method: string) {
  return method === "GET" || method === "HEAD"
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: "{}" }
}

describe("the OpenCode-compat surface is gated in signed mode", () => {
  test("the route table is non-empty and includes the destructive worktree verbs", () => {
    // Guards the table-driven cases below: an empty or truncated surface list
    // would make every `test.each` vacuously pass.
    expect(SURFACES.length).toBeGreaterThan(30)
    expect(SURFACES).toContainEqual(["DELETE", "/experimental/worktree"])
    expect(SURFACES).toContainEqual(["POST", "/experimental/worktree/reset"])
    expect(SURFACES).toContainEqual(["PUT", "/auth/anthropic"])
    expect(SURFACES).toContainEqual(["PATCH", "/global/config"])
    expect(SURFACES).toContainEqual(["GET", "/file/content"])
  })

  test.each(SURFACES)("%s %s refuses an unauthenticated off-box request", async (method, route) => {
    const res = await signedApp().request(`http://box.example${route}`, requestInit(method))
    // 401 from the gate — never 200, and never a handler-level 400/404, which
    // would mean the request reached the handler before being rejected.
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
  })

  test("the destructive worktree delete never reaches its fs.rm sink", async () => {
    const victim = path.join(root, "victim")
    mkdirSync(victim, { recursive: true })
    await fs.writeFile(path.join(victim, "PRECIOUS.txt"), "keep me")

    const res = await signedApp().request(
      `http://box.example/experimental/worktree?workspaceId=ws_a&directory=${encodeURIComponent(victim)}`,
      { method: "DELETE" },
    )

    expect(res.status).toBe(401)
    expect(await fs.readFile(path.join(victim, "PRECIOUS.txt"), "utf8")).toBe("keep me")
  })

  test("a malformed bearer token is refused rather than falling through", async () => {
    const res = await signedApp().request("http://box.example/experimental/worktree", {
      method: "DELETE",
      headers: { authorization: "Bearer not-a-real-jwt" },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_bearer_token" } })
  })
})

describe("legitimate callers still reach the handlers", () => {
  test("a verified bearer passes the gate in signed mode", async () => {
    const res = await signedApp().request("http://box.example/find/symbol", {
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("a verified bearer reaches the worktree handler's own validation", async () => {
    const res = await signedApp().request("http://box.example/experimental/worktree", {
      method: "DELETE",
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    })
    // The handler's "directory is required" — proof the request got past the
    // gate rather than being answered by it.
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "opencode_directory_required" } })
  })

  test("the local unsigned desktop path still works with no Authorization header", async () => {
    const res = await unsignedLocalApp().request("http://localhost:3001/find/symbol")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("the local unsigned desktop path still reaches the worktree handler", async () => {
    const res = await unsignedLocalApp().request("http://localhost:3001/experimental/worktree", { method: "DELETE" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "opencode_directory_required" } })
  })
})

describe("the gate stays inside the compat router", () => {
  // `app.route("/", sub)` re-registers the sub-app's middleware onto the PARENT
  // router, so a `.use("*", ...)` inside OpenCodeCompatRoutes would also gate
  // every parent route registered after the mount — in server.ts that is
  // /documents, /api/control, /api/workspace, /api/claxedo/events,
  // /internal/documents and more, several of which authenticate with something
  // other than a control-plane bearer (installation tokens, runtime access
  // tokens) and would start failing in signed mode. The gate is therefore
  // registered at the compat router's own paths, and this pins that.
  function serverLikeApp() {
    const app = new Hono()
    app.get("/global/health", (c) => c.json({ mountedBeforeCompat: true }))
    app.route("/", OpenCodeCompatRoutes({ authConfig: signedConfig, verifier }))
    app.get("/documents/doc_1", (c) => c.json({ mountedAfterCompat: true }))
    app.get("/api/claxedo/events", (c) => c.json({ mountedAfterCompat: true }))
    app.get("/api/control/sessions", (c) => c.json({ mountedAfterCompat: true }))
    return app
  }

  test("every gate is registered at one of the router's own paths, never a wildcard", () => {
    const all = OpenCodeCompatRoutes().routes
    const gates = all.filter((route) => route.method === "ALL").map((route) => route.path)
    const handlers = new Set(all.filter((route) => route.method !== "ALL").map((route) => route.path))

    // A wildcard gate is what leaks onto the parent router; there must be none.
    expect(gates.filter((route) => route.includes("*"))).toEqual([])
    // Exactly one gate per distinct handler path, and nothing else.
    expect([...new Set(gates)].sort()).toEqual([...handlers].sort())
    expect(gates.length).toBe(handlers.size)
  })

  test.each(["/documents/doc_1", "/api/claxedo/events", "/api/control/sessions"])(
    "%s, mounted after the compat router, is untouched by its gate",
    async (route) => {
      const res = await serverLikeApp().request(`http://box.example${route}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mountedAfterCompat: true })
    },
  )

  test("a route mounted before the compat router keeps answering first", async () => {
    const res = await serverLikeApp().request("http://box.example/global/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mountedBeforeCompat: true })
  })

  test("the destructive worktree verbs are not runtime-owned, so this gate is their gate", () => {
    // `workspaceRuntimeProxy` is mounted BEFORE the compat router in server.ts
    // and answers everything `routeOwnership` hands to the SandboxRuntime,
    // which would route around this gate. `/experimental/*` is central-owned,
    // so the worktree verbs reach the gated handlers. Reclassifying them would
    // silently neuter the fix.
    for (const route of ["/experimental/worktree", "/experimental/worktree/reset"]) {
      expect(routeOwnership(route).handler).not.toBe(RouteHandler.SandboxRuntime)
    }
  })

  /**
   * The one route that DOES take the runtime path on purpose. `/provider`
   * (exact) is runtime-owned so a workspace-scoped request — including one a
   * phone sends through the relay — reaches the workspace runtime instead of
   * being refused by the host tunnel's ownership guard. The runtime answers
   * non-opencode harnesses through the host-injected catalog, so this is not
   * an escape from a gate, it is the same catalog by another door.
   *
   * Its children are NOT: the OAuth flows under `/provider/<id>/...` and
   * `/provider/auth` are central and gated here, and the runtime implements
   * none of them. A prefix rule would have taken them along.
   */
  test("/provider alone is runtime-owned; its auth and oauth children stay behind this gate", () => {
    expect(routeOwnership("/provider").handler).toBe(RouteHandler.SandboxRuntime)
    for (const route of ["/provider/auth", "/provider/anthropic/oauth/authorize", "/provider/claude-acp/oauth/start"]) {
      expect(routeOwnership(route).handler).not.toBe(RouteHandler.SandboxRuntime)
    }
  })
})
