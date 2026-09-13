import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import { runtimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { createRuntimeCredentialIssuer } from "@claxedo/workspace-runtime"
import type { TasksActor, TasksSessionBridgePort } from "@claxedo/tasks"
import type { TasksRuntimePrincipal } from "@claxedo/server-core/tasks-host/authorization"

import { createHostedCoreApp } from "./hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "./deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { createHostedTasksComposition } from "../../tasks/hosted-composition"
import { mintTasksCapability } from "../../tasks/capability"
import { mintMcpGatewayToken } from "../../agent-plugins/mcp/runtime-token"

/**
 * Every credential a sandbox can carry, against every route the composed
 * control plane actually mounts.
 *
 * Both halves are read from the running composition instead of written down.
 * The routes are the Hono table `createHostedCoreApp` builds, so a new mount is
 * swept the moment it exists. The credentials are minted by the same functions
 * that mint them in production, and which routes each one reaches is decided by
 * presenting it to all of them: a 401 or a 403 is the boundary refusing it,
 * anything else is the credential already inside.
 *
 * What a reached route then has to satisfy is that it never resolves a scope
 * name its caller supplied without checking it against the credential. Asking
 * only whether a stranger's names are refused would fail every route that
 * mirrors a string back for a client to display, so the question is asked three
 * ways — about a stranger who exists, about a stranger who does not, and about
 * nobody. A mirror answers the two strangers identically. A route that answers
 * them differently looked one of them up, and the one it looked up belongs to
 * somebody this credential does not act for.
 */

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(["0024_claxedo_tasks.sql"])
  active.push(instance)
  return instance.database
}

const OWN = { orgId: "org-1", projectId: "project-a", workspaceId: "ws_root" } as const
/** A stranger's scope that this control plane knows and can resolve. */
const FOREIGN = { orgId: "org-2", projectId: "project-b", workspaceId: "ws_other" } as const
/** A stranger's scope that this control plane has never heard of. */
const DECOY = { orgId: "org-absent", projectId: "project-absent", workspaceId: "ws_absent" } as const
/** Neither scope. Path segments have to say something, so they say something that is nobody's. */
const UNNAMED = { orgId: "org-none", projectId: "project-none", workspaceId: "ws_none" } as const

type ScopeNames = typeof OWN | typeof FOREIGN | typeof DECOY | typeof UNNAMED

const ORGS: Record<string, string> = { alice: "org-1", bob: "org-2" }

/**
 * Two roots that exist, owned by different people. A sweep in which the
 * stranger's workspace does not exist cannot tell a route that resolved a name
 * it never checked from one that only echoed it back.
 */
const WORKSPACE_OWNERS: Record<string, { userId: string; actorId: string; orgId: string; projectId: string }> = {
  ws_root: { userId: "alice", actorId: "actor:alice", orgId: "org-1", projectId: "project-a" },
  ws_other: { userId: "bob", actorId: "actor:bob", orgId: "org-2", projectId: "project-b" },
}

function plane(): HostedControlPlane {
  const sessionAuthority = {
    reserveSession: vi.fn(async () => ({ state: "reserved" })),
    registerRuntimeSession: vi.fn(async () => ({})),
    markSessionRegistrationAmbiguous: vi.fn(async () => ({})),
    beginSessionCompensation: vi.fn(async () => ({})),
    completeSessionCompensation: vi.fn(async () => ({})),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" } },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async (auth: { user: { subject: string } }) => ORGS[auth.user.subject] ?? "org-unknown"),
      authorizeProject: vi.fn(async (auth: { user: { subject: string } }, args: { projectId: string }) =>
        ORGS[auth.user.subject] === "org-1" && args.projectId === "project-a"
          ? { ok: true, role: "admin", orgId: "org-1" }
          : { ok: false },
      ),
      authorizeSessionRead: vi.fn(async () => undefined),
      resolveWorkspaceOwner: vi.fn(async (workspaceId: string) => WORKSPACE_OWNERS[workspaceId]),
      usersMe: vi.fn(async () => ({ user_id: "user-1" })),
      listOrgs: vi.fn(async () => [{ org_id: "org-1" }]),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120_000,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 120_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: createInMemoryCliSessionTokenRegistry(),
    privateSessionAuthority: sessionAuthority,
    runtimeSessionAuthority: sessionAuthority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
  } as unknown as HostedControlPlane
}

/** Start belongs to the bridge, not to this boundary; it refuses and names the principal it was handed. */
function reportingBridge(principal: TasksRuntimePrincipal): TasksSessionBridgePort {
  const refuse = async (actor: TasksActor) => {
    const resolved = await principal(actor)
    return {
      ok: false as const,
      error: { code: "unsupported" as const, message: `principal ${resolved ? resolved.actorId : "absent"}` },
    }
  }
  return {
    async sessionState(origins) {
      return origins.map((origin) => ({
        session: origin.sessionRef,
        state: "unavailable" as const,
        handoff: "unknown" as const,
      }))
    },
    preview: (command) => refuse(command.actor),
    start: (command) => refuse(command.actor),
    handoff: (command) => refuse(command.actor),
    abandon: (command) => refuse(command.actor),
  }
}

type SigningEnv = Record<string, string | undefined>

async function signingEnv(): Promise<SigningEnv> {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

type ProbeApp = { request(input: string, init?: RequestInit): Promise<Response>; routes: readonly { method: string; path: string }[] }

async function hostedApp(
  env: SigningEnv,
  extraContributions: readonly ControlPlaneRouteContribution[] = [],
): Promise<ProbeApp> {
  const base = plane()
  const authentication = testRequestAuthenticationAdapter()
  const tasks = createHostedTasksComposition({
    services: base.services,
    database: await database(),
    authentication,
    bridge: reportingBridge,
    signingEnv: env,
  })
  return createHostedCoreApp(base, {
    authentication,
    liveSyncRoom: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
    serviceCatalog: async () => [],
    cloudWorkspaceAdmission: async () => ({
      status: 403 as const,
      body: { error: { code: "cloud_workspace_capability_unavailable", message: "Capability unavailable" } },
    }),
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    requestGuardExemptions: [],
    userDeployedIdentityAdmission: {
      admit: vi.fn(async (_auth: unknown, input: { identity: { subject: string } }) => ({
        state: "active" as const,
        userId: `user:${input.identity.subject}`,
        actorId: `actor:${input.identity.subject}`,
      })),
    },
    routeContributions: [...tasks.routeContributions, ...extraContributions],
  } as unknown as Parameters<typeof createHostedCoreApp>[1]) as unknown as ProbeApp
}

/** Every credential a sandbox holds, minted by the function that mints it in production. */
type SandboxCredential = { kind: string; mint(env: SigningEnv): Promise<string> }

const SANDBOX_CREDENTIALS: readonly SandboxCredential[] = [
  {
    kind: "host signed token",
    mint: async (env) =>
      (
        await runtimeAccessTokenSigner(env as NodeJS.ProcessEnv)({
          orgId: OWN.orgId,
          workspaceId: OWN.workspaceId,
          hostId: "host_1",
          principalKind: "user",
          actorId: "actor:alice",
          actorKind: "human",
          role: "owner",
        })
      ).runtimeAccessToken,
  },
  {
    kind: "Tasks capability",
    mint: async (env) =>
      (
        await mintTasksCapability(
          {
            userId: "alice",
            orgId: OWN.orgId,
            projectId: OWN.projectId,
            workspaceId: OWN.workspaceId,
            sessionId: "ses_1",
            operations: ["read", "create", "start"],
          },
          env,
        )
      ).token,
  },
  {
    kind: "gateway capability",
    mint: async (env) =>
      (
        await mintMcpGatewayToken(
          {
            userId: "alice",
            orgId: OWN.orgId,
            projectId: OWN.projectId,
            workspaceId: OWN.workspaceId,
            harnessId: "claude",
            pluginInstanceId: "plugin_1",
            serverName: "server",
            integrationId: "integration_1",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            execution: "default",
          },
          env,
        )
      ).token,
  },
  {
    kind: "loopback runtime bearer",
    mint: async () =>
      createRuntimeCredentialIssuer({ runtimeId: "runtime_1", workspaceId: OWN.workspaceId, userId: "alice" }).current(
        "ses_1",
      ),
  },
]

/** Path segments that carry a scope name, and the ones that carry an opaque row id. */
const SCOPED_PARAMS: Record<string, keyof ScopeNames> = {
  id: "workspaceId",
  workspaceId: "workspaceId",
  orgId: "orgId",
  projectId: "projectId",
}

const OPAQUE_PARAMS: Record<string, string> = {
  sessionId: "ses_probe",
  taskId: "tsk_probe",
  presetId: "prs_probe",
  checkpointId: "ckp_probe",
  teamId: "team_probe",
  hostId: "host_probe",
  providerID: "anthropic",
  operation: "start",
}

function probeUrl(path: string, scope: ScopeNames, named: boolean) {
  const filled = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment
      const name = segment.slice(1)
      const scoped = SCOPED_PARAMS[name]
      if (scoped) return scope[scoped]
      return OPAQUE_PARAMS[name] ?? `${name}_probe`
    })
    .join("/")
  const url = new URL(`https://core.test${filled}`)
  if (named) {
    url.searchParams.set("workspaceId", scope.workspaceId)
    url.searchParams.set("projectId", scope.projectId)
    url.searchParams.set("orgId", scope.orgId)
  }
  return url.toString()
}

/**
 * A body that names a workspace, a project and an organization everywhere a
 * control-plane body is known to carry them, including the one nested place
 * the Tasks command envelope puts them.
 */
function probeBody(scope: ScopeNames, named: boolean, requestId: string) {
  const names = named
    ? { workspaceId: scope.workspaceId, projectId: scope.projectId, orgId: scope.orgId }
    : {}
  return JSON.stringify({
    clientRequestId: requestId,
    ...names,
    command: {
      type: "task.create",
      input: {
        ...(named ? { projectId: scope.projectId, orgId: scope.orgId } : {}),
        title: "probe",
        description: "",
        workspaceId: null,
        parentTaskId: null,
      },
    },
  })
}

const SCOPE_LITERALS: readonly [RegExp, string][] = [
  [/ws_root|ws_other|ws_absent|ws_none/g, "«workspace»"],
  [/project-a|project-b|project-absent|project-none/g, "«project»"],
  [/org-1|org-2|org-absent|org-none/g, "«org»"],
  [/probe-[0-9]+/g, "«request»"],
  [/\b(?:tsk|prs|cmd|ses|ckp)_[A-Za-z0-9_-]{6,}/g, "«row»"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "«uuid»"],
  [/\b1[0-9]{12}\b/g, "«time»"],
]

/** What a route answered, with the names the probe supplied collapsed so only the shape of the answer remains. */
function signature(status: number, body: string) {
  let normalized = body
  for (const [pattern, replacement] of SCOPE_LITERALS) normalized = normalized.replaceAll(pattern, replacement)
  return `${status} ${normalized}`
}

let requestCounter = 0

async function probe(
  app: ProbeApp,
  route: { method: string; path: string },
  scope: ScopeNames,
  options: { named: boolean; token?: string },
) {
  const method = route.method === "ALL" ? "POST" : route.method
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const init: RequestInit = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    init.body = probeBody(scope, options.named, `probe-${(requestCounter += 1)}`)
  }
  const response = await app.request(probeUrl(route.path, scope, options.named), init)
  // An event stream never ends, so the status is all of it that can be read.
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return signature(response.status, "«stream»")
  }
  return signature(response.status, await response.text())
}

/** Concrete endpoints. A path ending in `*` is a mount or a middleware, not a route a credential arrives at. */
function endpoints(app: ProbeApp) {
  const unique = new Map<string, { method: string; path: string }>()
  for (const route of app.routes) {
    if (route.path.endsWith("*")) continue
    unique.set(`${route.method} ${route.path}`, { method: route.method, path: route.path })
  }
  return [...unique.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))
}

type ReachedRoute = { method: string; path: string; status: number }
type Reachability = { reached: ReachedRoute[]; unprobed: string[] }

/**
 * The routes a credential reaches, decided by what the composition answers
 * rather than by where its authenticators are installed.
 *
 * A 401 or a 403 is the boundary refusing the credential; anything else is the
 * credential already inside the route, whether the route then finds the row it
 * was asked about or not. A changed error message is deliberately NOT
 * admission: presenting an unreadable bearer changes what a 401 says on almost
 * every route, and a sweep that counted that would report the whole table as
 * reachable by everything.
 *
 * A 5xx is neither. This composition stubs the workspace authority, so a route
 * that needs a method the stub lacks cannot answer at all; those are reported
 * as unprobed rather than counted as swept.
 */
async function reachedRoutes(
  env: SigningEnv,
  credential: SandboxCredential,
  extra: readonly ControlPlaneRouteContribution[],
): Promise<Reachability> {
  const token = await credential.mint(env)
  const app = await hostedApp(env, extra)
  const reached: ReachedRoute[] = []
  const unprobed: string[] = []
  for (const route of endpoints(app)) {
    const answer = await probe(app, route, OWN, { named: true, token })
    const status = Number(answer.slice(0, 3))
    if (status === 401 || status === 403) continue
    if (status >= 500) {
      unprobed.push(`${route.method} ${route.path}`)
      continue
    }
    reached.push({ ...route, status })
  }
  return { reached, unprobed }
}

const routeLabel = (route: ReachedRoute) => `${route.method} ${route.path} -> ${route.status}`

type ScopeFinding = { route: string; foreign: string; decoy: string; unnamed: string }

/**
 * The invariant, one route at a time on its own composition so that a write
 * made by one probe cannot become another probe's answer.
 *
 * A 2xx answer to a stranger's names is a defect only when the route resolved
 * them. The same question asked about a stranger who exists and about a
 * stranger who does not separates the two: a route that mirrors a string back
 * for a client to display answers both identically, and a route that looked
 * the name up answers them differently — and the one it answered about belongs
 * to somebody who is not this credential's owner.
 */
async function scopeFindings(
  env: SigningEnv,
  credential: SandboxCredential,
  routes: readonly { method: string; path: string }[],
  extra: readonly ControlPlaneRouteContribution[],
) {
  const findings: ScopeFinding[] = []
  for (const route of routes) {
    const token = await credential.mint(env)
    const app = await hostedApp(env, extra)
    const foreign = await probe(app, route, FOREIGN, { named: true, token })
    if (!foreign.startsWith("2")) continue
    const decoy = await probe(app, route, DECOY, { named: true, token })
    const unnamed = await probe(app, route, UNNAMED, { named: false, token })
    if (foreign !== decoy && foreign !== unnamed) {
      findings.push({ route: `${route.method} ${route.path}`, foreign, decoy, unnamed })
    }
  }
  return findings
}

function reportFindings(kind: string, findings: readonly ScopeFinding[]) {
  return findings
    .map(
      (finding) =>
        `${kind} reached ${finding.route} naming a stranger's workspace, project and organization and resolved them`
        + `\n  the stranger who exists:     ${finding.foreign}`
        + `\n  the stranger who does not:   ${finding.decoy}`
        + `\n  naming nobody:               ${finding.unnamed}`,
    )
    .join("\n")
}

/**
 * A route that resolves the workspace its caller's body names without asking
 * whose credential arrived with it. The defect this guard exists to catch.
 */
function bodyTrustingContribution(): ControlPlaneRouteContribution {
  const routes = new Hono()
  routes.post("/act", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: unknown }
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined
    const owner = workspaceId ? WORKSPACE_OWNERS[workspaceId] : undefined
    return c.json({ owner: owner ? owner.userId : null })
  })
  return { id: "probe-body-trusting", path: "/api/claxedo/probe", routes }
}

describe("what a sandbox's credentials reach on the hosted control plane", () => {
  test("every credential kind is minted by the production minter and reaches only routes that check its scope", async () => {
    const env = await signingEnv()
    const inventory: Record<string, string[]> = {}
    const unswept: Record<string, string[]> = {}
    const failures: string[] = []

    for (const credential of SANDBOX_CREDENTIALS) {
      const { reached, unprobed } = await reachedRoutes(env, credential, [])
      inventory[credential.kind] = reached.map(routeLabel)
      unswept[credential.kind] = unprobed
      const findings = await scopeFindings(env, credential, reached, [])
      if (findings.length > 0) failures.push(reportFindings(credential.kind, findings))
    }

    // Positive control. Every assertion below holds for a sweep that reached
    // nothing, and a sweep that reached everything would report the same
    // routes for every credential; these two facts hold only if the
    // enumeration actually discriminated.
    expect({
      tasksCapabilityReachesTheTaskList: inventory["Tasks capability"]?.includes(
        "GET /api/claxedo/tasks/tasks -> 200",
      ),
      gatewayCapabilityDoesNot: inventory["gateway capability"]?.some((route) =>
        route.startsWith("GET /api/claxedo/tasks/tasks -> "),
      ),
    }).toEqual({ tasksCapabilityReachesTheTaskList: true, gatewayCapabilityDoesNot: false })

    expect(
      failures.length === 0
        ? ""
        : `${failures.join("\n")}\n\nswept:\n${JSON.stringify({ reached: inventory, unprobed: unswept }, null, 1)}`,
    ).toBe("")
  }, 600_000)

  test("the sweep fails on a route that acts on the workspace its caller's body names", async () => {
    const env = await signingEnv()
    const extra = [bodyTrustingContribution()]
    const credential = SANDBOX_CREDENTIALS.find((candidate) => candidate.kind === "Tasks capability")
    if (!credential) throw new Error("the credential inventory lost the Tasks capability")

    const { reached } = await reachedRoutes(env, credential, extra)
    const findings = await scopeFindings(env, credential, reached, extra)

    expect(findings.map((finding) => finding.route)).toContain("POST /api/claxedo/probe/act")
  }, 600_000)
})
