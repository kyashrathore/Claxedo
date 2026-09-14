import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
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
 * that mint them in production. Which routes admit each one is decided by
 * presenting it to all of them and subtracting what the plane answers to no
 * credential at all: a 401 or a 403 is the boundary refusing it, anything else
 * is the credential already inside. The admitted set is then asserted exactly,
 * so a credential that reaches one route more fails the test instead of
 * widening an inventory.
 *
 * What an admitted route then has to satisfy is that a request naming a
 * stranger's scope is refused. The names are put everywhere a control-plane
 * request is known to carry them — path, query, the top of the body and the
 * nested places the Tasks command envelope has — and, for a body, one nested
 * place at a time as well, so a route that checks the outer names and stores
 * an inner one is caught. A 2xx to a stranger is a finding unless the route is
 * one of the few declared below to read no name at all, and those are held to
 * answering the stranger and the caller alike, byte for byte.
 *
 * The signed-request path is the production one over an adapter that admits
 * only the two users this plane knows. The production adapter introspects a
 * token with its provider, which a test cannot reach; what matters here is
 * that a sandbox's credential is not a user's, and an adapter that admitted
 * any bearer as a user made every credential reach every signed route.
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

const OWN = { orgId: "org-1", projectId: "project-a", workspaceId: "ws_root", sessionId: "ses_1" } as const
/** A stranger's scope that this control plane knows and can resolve. */
const FOREIGN = { orgId: "org-2", projectId: "project-b", workspaceId: "ws_other", sessionId: "ses_victim" } as const
/** A stranger's scope that this control plane has never heard of. */
const DECOY = { orgId: "org-absent", projectId: "project-absent", workspaceId: "ws_absent", sessionId: "ses_absent" } as const

type ScopeNames = typeof OWN | typeof FOREIGN | typeof DECOY

/** The users the plane knows. Any other bearer is nobody's. */
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

function knownUsersAuthentication(): RequestAuthenticationAdapter {
  const adapter = testRequestAuthenticationAdapter()
  return {
    descriptor: adapter.descriptor,
    authenticate: async (request) => {
      const bearer = bearerToken(request.headers.get("authorization"))
      if (bearer !== undefined && !(bearer in ORGS)) {
        throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      }
      return await adapter.authenticate(request)
    },
  }
}

type SigningEnv = Record<string, string | undefined>

function plane(signing: SigningEnv): HostedControlPlane {
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
      listSessions: vi.fn(async () => []),
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
    // The runtime-authority routes verify a host's signed token against the
    // same key the sandbox credentials are minted with.
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted", ...signing },
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
  const base = plane(env)
  const authentication = knownUsersAuthentication()
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
            sessionId: OWN.sessionId,
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
        OWN.sessionId,
      ),
  },
]

/**
 * What each sandbox credential is admitted to, beyond what the plane answers
 * to nobody. The Tasks capability reaches exactly the Tasks routes and nothing
 * signed; the gateway token is signed with the same key and must reach none of
 * them; a host's signed token is verified by the runtime it addresses and the
 * relay in front of it, never by this plane; the runtime's own bearer never
 * leaves the sandbox's loopback and is nobody here.
 *
 * The status beside each route is the answer to the caller's own names, which
 * says how far the probe body got: a 2xx or a 404 is a route that read the
 * request, a 400 is one that rejected the generic body and was swept for
 * admission alone.
 */
const EXPECTED_ADMISSION: Record<string, readonly string[]> = {
  "host signed token": [],
  "Tasks capability": [
    "GET /api/claxedo/tasks/capabilities -> 200",
    "POST /api/claxedo/tasks/commands -> 200",
    "GET /api/claxedo/tasks/presets -> 200",
    "GET /api/claxedo/tasks/presets/:presetId -> 404",
    "GET /api/claxedo/tasks/tasks -> 200",
    "GET /api/claxedo/tasks/tasks/:taskId -> 404",
    "GET /api/claxedo/tasks/tasks/:taskId/children -> 404",
    "POST /api/claxedo/tasks/tasks/:taskId/sessions -> 400",
    "POST /api/claxedo/tasks/tasks/:taskId/start-preview -> 400",
  ],
  "gateway capability": [],
  "loopback runtime bearer": [],
}

/**
 * Routes that read no scope name from a request at all, so a stranger's names
 * get the same answer as the caller's. Each is held to exactly that: an
 * answer that differs in any byte means the route read a name after all.
 */
const NAME_FREE_ROUTES: readonly string[] = [
  "GET /.well-known/jwks.json",
  "GET /api/claxedo/auth/descriptor",
  "GET /api/claxedo/compatibility",
  "GET /api/claxedo/health",
  "GET /api/claxedo/mode",
  "GET /api/claxedo/services",
  "GET /api/workspace",
  "GET /api/workspace/resolve",
  "GET /global/health",
]

/**
 * The shell's directory shims, which answer a client's own workspace name
 * back to it as a path and look nothing up. Each is held to answering a
 * stranger who exists, a stranger who does not and the caller identically
 * once the names are collapsed: a route that had resolved the name would
 * answer the two strangers differently.
 */
const ECHO_ROUTES: readonly string[] = ["GET /path", "GET /project", "GET /project/current"]

/**
 * Routes this fixture cannot answer for, each with the answer it gives before
 * any credential is read. Anything else above 499 fails the sweep.
 */
const UNAVAILABLE_ROUTES: Record<string, number> = {
  // No Pi credential store is composed, and the route says so first.
  "DELETE /auth/:providerID": 503,
  "PUT /auth/:providerID": 503,
}

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

function probeUrl(path: string, scope: ScopeNames) {
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
  url.searchParams.set("workspaceId", scope.workspaceId)
  url.searchParams.set("projectId", scope.projectId)
  url.searchParams.set("orgId", scope.orgId)
  return url.toString()
}

/**
 * Where a stranger's names go in one probe. `everywhere` is every place at
 * once, path and query included; the nested placements put the stranger in
 * one field of the Tasks command envelope and the caller's own names in every
 * other place, which is the shape of a route that checks the outer names and
 * stores the inner one.
 */
type Placement = "everywhere" | "input.projectId" | "input.workspaceId" | "input.createdFrom"

const BODY_PLACEMENTS: readonly Placement[] = ["everywhere", "input.projectId", "input.workspaceId", "input.createdFrom"]

/**
 * A valid `task.create` envelope, which is the one control-plane body that
 * carries a workspace, a project and an organization at the top and nests a
 * project, a workspace and a session reference under `input`. Every route is
 * sent it; the ones that read another shape reject it with a 400 and are swept
 * for admission alone.
 */
function probeBody(caller: ScopeNames, stranger: ScopeNames, placement: Placement, requestId: string) {
  const outer = placement === "everywhere" ? stranger : caller
  const at = (field: Placement) => (placement === "everywhere" || placement === field ? stranger : caller)
  return JSON.stringify({
    clientRequestId: requestId,
    workspaceId: outer.workspaceId,
    projectId: outer.projectId,
    orgId: outer.orgId,
    command: {
      type: "task.create",
      input: {
        projectId: at("input.projectId").projectId,
        orgId: outer.orgId,
        title: "probe",
        description: "",
        workspaceId: at("input.workspaceId").workspaceId,
        createdFrom: { workspaceId: at("input.createdFrom").workspaceId, sessionId: at("input.createdFrom").sessionId },
        parentTaskId: null,
      },
    },
  })
}

/** What one answer carried, with the per-request noise collapsed so two probes of one route compare. */
const VOLATILE: readonly [RegExp, string][] = [
  [/probe-[0-9]+/g, "«request»"],
  [/\b(?:tsk|prs|cmd|ses|ckp)_[A-Za-z0-9_-]{6,}/g, "«row»"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "«uuid»"],
  [/\b1[0-9]{12}\b/g, "«time»"],
]

/** The names an echo route is allowed to answer back, collapsed so its three answers compare. */
const SCOPE_LITERALS: readonly [RegExp, string][] = [
  [/ws_root|ws_other|ws_absent/g, "«workspace»"],
  [/project-a|project-b|project-absent/g, "«project»"],
  [/org-1|org-2|org-absent/g, "«org»"],
]

function signature(status: number, body: string) {
  let normalized = body
  for (const [pattern, replacement] of VOLATILE) normalized = normalized.replaceAll(pattern, replacement)
  return `${status} ${normalized}`
}

function echoed(answer: string) {
  let normalized = answer
  for (const [pattern, replacement] of SCOPE_LITERALS) normalized = normalized.replaceAll(pattern, replacement)
  return normalized
}

const statusOf = (answer: string) => Number(answer.slice(0, 3))

let requestCounter = 0

type Route = { method: string; path: string }
const routeLabel = (route: Route) => `${route.method} ${route.path}`

async function probe(
  app: ProbeApp,
  route: Route,
  names: { caller: ScopeNames; stranger: ScopeNames; placement: Placement },
  token: string | undefined,
) {
  const method = route.method === "ALL" ? "POST" : route.method
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    init.body = probeBody(names.caller, names.stranger, names.placement, `probe-${(requestCounter += 1)}`)
  }
  const pathNames = names.placement === "everywhere" ? names.stranger : names.caller
  const response = await app.request(probeUrl(route.path, pathNames), init)
  // An event stream never ends, so the status is all of it that can be read.
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return signature(response.status, "«stream»")
  }
  return signature(response.status, await response.text())
}

/** Concrete endpoints. A path ending in `*` is a mount or a middleware, not a route a credential arrives at. */
function endpoints(app: ProbeApp): Route[] {
  const unique = new Map<string, Route>()
  for (const route of app.routes) {
    if (route.path.endsWith("*")) continue
    unique.set(routeLabel(route), { method: route.method, path: route.path })
  }
  return [...unique.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))
}

const OWN_NAMES = { caller: OWN, stranger: OWN, placement: "everywhere" } as const

/**
 * The routes a credential is inside, decided by what the composition answers
 * to the caller's own names rather than by where its authenticators are
 * installed. A 401 or a 403 is the boundary refusing it. A changed error
 * message is deliberately NOT admission: presenting an unreadable bearer
 * changes what a 401 says on almost every route, and a sweep that counted that
 * would report the whole table as reachable by everything.
 *
 * A 5xx is a route the fixture could not answer for, and a route that cannot
 * be answered for cannot be swept: it is reported and the sweep fails, so a
 * stub that falls behind the composition is a red test rather than a route
 * silently left out.
 */
async function reached(app: ProbeApp, token: string | undefined) {
  const inside = new Map<string, number>()
  const unanswerable: string[] = []
  for (const route of endpoints(app)) {
    const status = statusOf(await probe(app, route, OWN_NAMES, token))
    if (status === 401 || status === 403) continue
    if (status >= 500) {
      if (UNAVAILABLE_ROUTES[routeLabel(route)] !== status) unanswerable.push(`${routeLabel(route)} -> ${status}`)
      continue
    }
    inside.set(routeLabel(route), status)
  }
  return { inside, unanswerable }
}

type ScopeFinding = { route: string; placement: Placement; stranger: string; answer: string }

/**
 * The invariant, one probe at a time on its own composition so that a write
 * made by one probe cannot become another probe's answer. A name-free route is
 * asked the caller's names on the same composition, so the two answers can be
 * compared byte for byte.
 */
async function scopeFindings(
  env: SigningEnv,
  credential: SandboxCredential | undefined,
  routes: readonly Route[],
  extra: readonly ControlPlaneRouteContribution[],
): Promise<ScopeFinding[]> {
  const findings: ScopeFinding[] = []
  for (const route of routes) {
    const placements: readonly Placement[] = route.method === "GET" ? ["everywhere"] : BODY_PLACEMENTS
    const strangers: readonly [string, ScopeNames][] = [["the stranger who exists", FOREIGN], ["the stranger who does not", DECOY]]
    for (const placement of placements) {
      for (const [stranger, names] of strangers) {
        if (placement !== "everywhere" && names === DECOY) continue
        const token = credential ? await credential.mint(env) : undefined
        const app = await hostedApp(env, extra)
        const answer = await probe(app, route, { caller: OWN, stranger: names, placement }, token)
        if (NAME_FREE_ROUTES.includes(routeLabel(route)) || ECHO_ROUTES.includes(routeLabel(route))) {
          const own = await probe(app, route, OWN_NAMES, token)
          const compare = ECHO_ROUTES.includes(routeLabel(route)) ? echoed : (value: string) => value
          if (compare(answer) !== compare(own)) {
            findings.push({ route: routeLabel(route), placement, stranger, answer: `${answer}\n  the caller:   ${own}` })
          }
          continue
        }
        if (answer.startsWith("2")) findings.push({ route: routeLabel(route), placement, stranger, answer })
      }
    }
  }
  return findings
}

function reportFindings(kind: string, findings: readonly ScopeFinding[]) {
  return findings
    .map(
      (finding) =>
        `${kind} reached ${finding.route} naming ${finding.stranger} at ${finding.placement} and was answered:\n  ${finding.answer}`,
    )
    .join("\n")
}

/**
 * The defect this guard exists to catch, in the shape that hides best: the
 * outer names are checked, the nested workspace is stored, and the answer is
 * a constant success that names nothing back.
 */
function outerCheckedInnerTrustingContribution(): ControlPlaneRouteContribution {
  const routes = new Hono()
  const stored: string[] = []
  routes.post("/act", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: unknown
      command?: { input?: { workspaceId?: unknown } }
    }
    if (body.workspaceId !== OWN.workspaceId) return c.json({ error: "not your workspace" }, 403)
    const nested = body.command?.input?.workspaceId
    if (typeof nested === "string" && WORKSPACE_OWNERS[nested]) stored.push(nested)
    return c.json({ ok: true })
  })
  return { id: "probe-inner-trusting", path: "/api/claxedo/probe", routes }
}

describe("what a sandbox's credentials reach on the hosted control plane", () => {
  test("each credential is admitted to exactly the routes its kind is for, and every route sweeps", async () => {
    const env = await signingEnv()
    const nobody = await reached(await hostedApp(env), undefined)
    const admission: Record<string, string[]> = {}
    const unanswerable: Record<string, string[]> = { nobody: nobody.unanswerable }
    for (const credential of SANDBOX_CREDENTIALS) {
      const app = await hostedApp(env)
      const { inside, unanswerable: failed } = await reached(app, await credential.mint(env))
      unanswerable[credential.kind] = failed
      admission[credential.kind] = [...inside]
        .filter(([route]) => !nobody.inside.has(route))
        .map(([route, status]) => `${route} -> ${status}`)
    }
    expect(unanswerable).toEqual({ nobody: [], ...Object.fromEntries(SANDBOX_CREDENTIALS.map((credential) => [credential.kind, []])) })
    expect(admission).toEqual(EXPECTED_ADMISSION)
    // The declared lists may only name routes that exist and are swept: one
    // that vanished would otherwise stay declared forever.
    const swept = new Set([...nobody.inside.keys(), ...Object.values(EXPECTED_ADMISSION).flat().map((entry) => entry.split(" -> ")[0])])
    expect([...NAME_FREE_ROUTES, ...ECHO_ROUTES].filter((route) => !swept.has(route))).toEqual([])
  }, 600_000)

  test("no route answers a stranger's names with success, whether the names are outside or nested", async () => {
    const env = await signingEnv()
    const nobody = await reached(await hostedApp(env), undefined)
    const publicRoutes = endpoints(await hostedApp(env)).filter((route) => nobody.inside.has(routeLabel(route)))
    const failures: string[] = []

    const unauthenticated = await scopeFindings(env, undefined, publicRoutes, [])
    if (unauthenticated.length > 0) failures.push(reportFindings("nobody", unauthenticated))

    for (const credential of SANDBOX_CREDENTIALS) {
      const admitted = (EXPECTED_ADMISSION[credential.kind] ?? []).map((entry) => {
        const [method, path] = entry.split(" -> ")[0]?.split(" ") ?? []
        return { method: method ?? "", path: path ?? "" }
      })
      const findings = await scopeFindings(env, credential, admitted, [])
      if (findings.length > 0) failures.push(reportFindings(credential.kind, findings))
    }

    expect(failures.join("\n")).toBe("")
  }, 600_000)

  test("the sweep fails on a route that checks the outer names and stores the nested workspace", async () => {
    const env = await signingEnv()
    const extra = [outerCheckedInnerTrustingContribution()]
    const credential = SANDBOX_CREDENTIALS.find((candidate) => candidate.kind === "Tasks capability")
    if (!credential) throw new Error("the credential inventory lost the Tasks capability")
    const route = { method: "POST", path: "/api/claxedo/probe/act" }

    const { inside } = await reached(await hostedApp(env, extra), await credential.mint(env))
    expect(inside.get(routeLabel(route))).toBe(200)

    // The outer check hides the route from a probe that names the stranger
    // everywhere; only the nested placement reaches the store.
    const flagged = (await scopeFindings(env, credential, [route], extra)).map((finding) => finding.placement)
    expect(flagged).toContain("input.workspaceId")
    expect(flagged).not.toContain("everywhere")
  }, 600_000)
})
