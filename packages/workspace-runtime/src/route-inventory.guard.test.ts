import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp } from "./server"
import { relayWorkspaceRuntimeExposure } from "./exposure"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "./management-auth"
import { WorkspaceRuntimeRouteManifest, workspaceRuntimeRoute } from "./routes/manifest"
import type { RelayHostAuthOptions } from "./workspace-host-service-auth"

const tempDirs: string[] = []
const originalWorkspaceDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY

afterEach(async () => {
  if (originalWorkspaceDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  else process.env.WORKSPACE_RUNTIME_DIRECTORY = originalWorkspaceDirectory
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

const CONTRIBUTION_PROBE_PATH = "/inventory-probe"

const managementAuth: WorkspaceRuntimeManagementAuth = {
  authorize: async (input) =>
    input.request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) === "inventory-mgmt-token"
      ? { ok: true, subject: "route-inventory", scopes: [input.action] }
      : {
          ok: false,
          status: 401,
          code: "runtime_management_token_required",
          message: "Workspace runtime management token is required",
        },
}

/**
 * The widest composition `createWorkspaceRuntimeApp` mounts in production:
 * relay auth, a placed target (worktrees), transcripts, the management
 * channel, and a host route contribution, so every conditional mount branch
 * is exercised by the inventory.
 */
async function composedRuntime() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-route-inventory-"))
  tempDirs.push(dir)
  process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const relayHostAuth: RelayHostAuthOptions = { key: key.publicKey, workspaceId: "ws_1", hostId: "host_1" }
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    target: { workspaceId: "ws_1", directory: dir },
    managementAuth,
    managementTarget: { workspaceId: "ws_1", hostId: "host_1" },
    transcripts: {
      workspaceId: "ws_1",
      resolver: { open: async () => ({ state: "unavailable", reason: "route inventory probe" }) },
    },
    routeContributions: [{
      id: "inventory-probe",
      mount: () => ({
        path: "/",
        routes: new Hono().get(CONTRIBUTION_PROBE_PATH, (c) => c.json({ ok: true })),
        dispose: () => {},
      }),
    }],
  })
  return { runtime, key }
}

function mountedRoutes(app: { routes: Array<{ method: string; path: string }> }) {
  const mounted = new Map<string, { method: string; path: string }>()
  for (const route of app.routes) mounted.set(`${route.method} ${route.path}`, route)
  return [...mounted.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))
}

const SESSION_COMPAT_ROOTS = ["/session", "/session-start", "/question", "/permission", "/command", "/agent", "/experimental/session"]
const FILE_ADAPTER_ROOTS = ["/file", "/find/file"]
const HOST_STATUS_PATHS = ["/mcp", "/vcs"]
// Registered before the relay-auth middleware so an orchestrator can probe a
// runtime it holds no token for; the posture is deliberately unauthenticated.
const PRE_AUTH_PATHS = ["/global/health"]

function rootedAt(routePath: string, roots: readonly string[]) {
  return roots.some((root) => routePath === root || routePath.startsWith(`${root}/`))
}

/**
 * Every mount family outside `WorkspaceRuntimeRoutes` gets a named posture
 * here; a route that classifies as nothing is a mount nobody made an
 * authorization decision about, and the inventory fails on it.
 */
function mountPosture(route: { method: string; path: string }) {
  if (route.method === "ALL") return "mount-middleware"
  if (route.path.startsWith("/api/wr/documents")) return "document-hydration"
  if (route.path.startsWith("/api/wr/local-documents")) return "local-document-broker"
  if (rootedAt(route.path, [CONTRIBUTION_PROBE_PATH])) return "route-contribution"
  if (workspaceRuntimeRoute(route.path)) return "manifest-prefix"
  if (rootedAt(route.path, SESSION_COMPAT_ROOTS)) return "session-compat"
  if (rootedAt(route.path, FILE_ADAPTER_ROOTS)) return "file-adapter"
  if (HOST_STATUS_PATHS.includes(route.path)) return "host-status"
  if (PRE_AUTH_PATHS.includes(route.path)) return "unauthenticated-liveness"
  return undefined
}

function probePath(path: string) {
  return path.replace(/:[^/]+/g, "x")
}

const tokenInput = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  hostId: "host_1",
  role: "editor" as const,
  backing: "cloud-vm" as const,
  jti: "jti_inventory",
  parentJti: "rat_jti_inventory",
}

describe("composed app route/guard inventory", () => {
  test("every mounted route is a manifest family or a declared additional mount, and every manifest family is mounted", async () => {
    const { runtime } = await composedRuntime()
    try {
      const routes = mountedRoutes(runtime.app)
      const unclassified = routes.filter((route) => mountPosture(route) === undefined)
      expect(unclassified.map((route) => `${route.method} ${route.path}`)).toEqual([])

      const mounted = routes.map((route) => route.path)
      const unmounted = WorkspaceRuntimeRouteManifest.filter(
        (item) => !mounted.some((route) => route === item.path || route.startsWith(`${item.path}/`)),
      )
      expect(unmounted.map((item) => item.family)).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("anonymous requests are refused at every mounted entrypoint", async () => {
    const { runtime } = await composedRuntime()
    try {
      for (const route of mountedRoutes(runtime.app)) {
        const method = route.method === "ALL" ? "GET" : route.method
        const expected = mountPosture(route) === "unauthenticated-liveness" ? 200 : 401
        const response = await runtime.app.request(`http://localhost${probePath(route.path)}`, { method })
        expect([method, route.path, response.status]).toEqual([method, route.path, expected])
        if (expected === 401) {
          expect(await response.json()).toEqual({
            error: { code: "relay_host_token_required", message: "Relay Host Token is required" },
          })
        }
      }
    } finally {
      await runtime.dispose()
    }
  })

  test("a relay token scoped to another workspace is refused at every mounted entrypoint", async () => {
    const { runtime, key } = await composedRuntime()
    try {
      const foreign = await mintRelayHostToken({ ...tokenInput, workspaceId: "ws_2" }, key.privateKey, "EdDSA")
      for (const route of mountedRoutes(runtime.app)) {
        const method = route.method === "ALL" ? "GET" : route.method
        const expected = mountPosture(route) === "unauthenticated-liveness" ? 200 : 403
        const response = await runtime.app.request(`http://localhost${probePath(route.path)}`, {
          method,
          headers: {
            authorization: `Bearer ${foreign}`,
            "x-workspace-id": "ws_1",
            "x-forwarded-by": "workspace-relay",
          },
        })
        expect([method, route.path, response.status]).toEqual([method, route.path, expected])
      }
    } finally {
      await runtime.dispose()
    }
  })

  test("a correctly scoped relay token crosses the boundary to real handlers", async () => {
    const { runtime, key } = await composedRuntime()
    try {
      const token = await mintRelayHostToken({ ...tokenInput, workspaceId: "ws_1" }, key.privateKey, "EdDSA")
      const headers = {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      }
      for (const path of ["/api/wr/health", "/api/wr/capabilities", "/global/health", CONTRIBUTION_PROBE_PATH]) {
        const response = await runtime.app.request(`http://localhost${path}`, { headers })
        expect([path, response.status]).toEqual([path, 200])
      }
    } finally {
      await runtime.dispose()
    }
  })

  test("the management channel refuses relay tokens and wrong management tokens", async () => {
    const { runtime, key } = await composedRuntime()
    try {
      const relay = await mintRelayHostToken({ ...tokenInput, workspaceId: "ws_1" }, key.privateKey, "EdDSA")
      const relayHeaders = {
        authorization: `Bearer ${relay}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
        "content-type": "application/json",
      }
      // Config always answers through management auth; checkpoint falls to the
      // host-capability authority, which fails closed while none is configured.
      const relayOnlyExpected: Record<string, number> = {
        "/api/wr/config": 401,
        "/api/wr/checkpoint/freeze": 503,
      }
      for (const path of Object.keys(relayOnlyExpected)) {
        const relayOnly = await runtime.app.request(`http://localhost${path}`, {
          method: "POST",
          headers: relayHeaders,
          body: "{}",
        })
        expect([path, relayOnly.status]).toEqual([path, relayOnlyExpected[path]])

        const wrongManagement = await runtime.app.request(`http://localhost${path}`, {
          method: "POST",
          headers: { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: "wrong", "content-type": "application/json" },
          body: "{}",
        })
        expect([path, wrongManagement.status]).toEqual([path, 401])
        expect(await wrongManagement.json()).toEqual({
          error: { code: "runtime_management_token_required", message: "Workspace runtime management token is required" },
        })
      }

      const managed = await runtime.app.request("http://localhost/api/wr/checkpoint/freeze", {
        method: "POST",
        headers: { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: "inventory-mgmt-token", "content-type": "application/json" },
        body: "{}",
      })
      expect(managed.status).not.toBe(401)
    } finally {
      await runtime.dispose()
    }
  })
})
