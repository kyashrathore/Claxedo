/**
 * The hosted Connections composition on Better Auth + D1.
 *
 * This is the port of the Convex/Clerk-era `hosts/workgraph/hosted/connections-setup.ts`.
 * Everything the kit deliberately refuses to decide is decided here:
 *
 *   - WHO the caller is: an injected `authenticate` seam (production:
 *     `hostedConnectionsAuthenticate`, which is `signedOrError` over the
 *     deployment's `RequestAuthenticationAdapter`);
 *   - WHICH partitions the caller may touch: the D1 workspace authority maps
 *     the signed principal to an application `user_id` and `org_id`, and the
 *     owner keys stay `user:{userId}` / `org:{orgId}` — the partitions every
 *     other hosted surface (the app, the Agent Plugins MCP gateway) already
 *     reads;
 *   - WHERE the bytes live: connection metadata in D1 (`hosted_connections`),
 *     attempts in D1 (`hosted_connection_attempts`), secrets in the
 *     envelope-encrypted per-org KV store (`hostedOrgCredentials`).
 *
 * `ownerlessRows: "refuse"` is the hosted invariant: a hosted host must derive
 * its team partition from the caller's org and never expose the kit's
 * deployment-wide owner-absent partition.
 */
import {
  atlassianIntegration,
  createConnectionsService,
  createIntegrationRegistry,
  createIntegrationsRoutes,
  linearIntegration,
  type CredentialStorePort,
  type IntegrationCapability,
  type IntegrationDeclaration,
  type IntegrationImpl,
} from "@claxedo/connections"
import type { D1Database } from "@cloudflare/workers-types"
import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  ControlPlaneAuthError,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

import type { ControlPlaneCredentials, ControlPlaneServices } from "../../authority/services"
import { signedOrError } from "../../workspace/route-support"
import { hostedOrgCredentials } from "../../credentials/worker/index"
import { githubIntegrationForEnv } from "../github-oauth"
import { createD1ConnectionAttempts, HOSTED_ATTEMPT_SWEEP_RATE, type HostedConnectionAttempts } from "./attempts"
import { createD1ConnectionStore, HostedConnectionExistsError } from "./connection-store"
import type { HostedDynamicConnectionIntegrations } from "./types"

/**
 * The request-authentication seam. Mirrors `signedOrError`: an absent `auth`
 * means the request carried no signed principal (answered 403
 * `connections_org_required`), and an `error` is an authentication failure
 * served verbatim with its own status.
 */
export type HostedConnectionsAuthentication = (
  request: Request,
) => Promise<{ auth?: SignedControlPlaneAuth } | { error: unknown; status: number }>

export type HostedD1ConnectionsSetupInput = Readonly<{
  env: Record<string, string | undefined>
  database: D1Database
  services: ControlPlaneServices
  authenticate: HostedConnectionsAuthentication
  integrations?: ReadonlyArray<{ decl: IntegrationDeclaration; impl: IntegrationImpl }>
  /** Optional feature-owned integrations resolved from the authenticated durable owner context. */
  dynamicIntegrations?: HostedDynamicConnectionIntegrations
  /** Test seam. Production composes the envelope-encrypted per-org KV store below. */
  credentials?: (orgId: string) => ControlPlaneCredentials
  /** Test seam. Production composes the durable D1 attempt store below. */
  attempts?: HostedConnectionAttempts
  requireEntitlement?: (orgId: string) => Promise<{
    status: 402 | 503
    body: { error: { code: string; message: string } }
  } | undefined>
  /**
   * Whether THIS request also runs an attempt-retention pass. Injected so a
   * test can force or suppress the sweep instead of waiting on a coin flip.
   */
  sweepSample?: () => boolean
  now?: () => number
}>

/** The membership verdict every hosted Connections request is authorized against. */
type HostedMembership = Readonly<{ userId: string; orgId: string; role: string }>

const TEAM_WRITE_ROLES = new Set(["admin", "owner"])

const CALLBACK_FAILURE_PAGE =
  "<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Connection failed</h2><p>You can close this window and return to the app.</p></body></html>"

/**
 * Production `authenticate`: the same signed-only control-plane authentication
 * the rest of the hosted routes use. Kept a separate export so the setup itself
 * takes a plain function and stays testable without an authentication adapter.
 */
export function hostedConnectionsAuthenticate(input: Readonly<{
  authentication: RequestAuthenticationAdapter
  services: ControlPlaneServices
}>): HostedConnectionsAuthentication {
  return (request) =>
    signedOrError(request, { authentication: input.authentication, requireSigned: true }, input.services)
}

/**
 * The path this request addresses INSIDE the connections routes, whether the
 * setup is mounted (`app.route("/api/claxedo/integrations", setup)`) or served
 * standalone.
 *
 * Hono's `app.route` re-registers this app's routes under the mount prefix, so
 * `c.req.path` is the full request path while `c.req.routePath` is the matched
 * registration — `/api/claxedo/integrations` or `/api/claxedo/integrations/*`.
 * Subtracting the second from the first yields the mount-independent subpath;
 * the previous composition hard-coded the prefix in a regex instead, which
 * silently broke wherever the mount moved.
 */
function relativePath(c: Context): string {
  const route = c.req.routePath
  const prefix = route.endsWith("/*") ? route.slice(0, -2) : route === "/" ? "" : route
  return (prefix && c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : c.req.path) || "/"
}

/** Worker-safe Connections setup backed by D1 metadata, D1 attempts, and encrypted per-org credentials. */
export function createHostedD1ConnectionsSetup(input: HostedD1ConnectionsSetupInput) {
  const app = new Hono()
  const handle = async (c: Context) => {
    const subpath = relativePath(c)
    // The provider redirect carries no caller credential; the single-use TTL
    // attempt is what authorizes it, and its frozen routing is what selects the
    // tenant service.
    if (subpath === "/callback") return hostedCallback(input, c, subpath)

    const authenticated = await input.authenticate(c.req.raw)
    if ("error" in authenticated) {
      return c.json(authenticated.error as Record<string, unknown>, authenticated.status as ContentfulStatusCode)
    }
    const auth = authenticated.auth
    if (!auth) return c.json({ code: "connections_org_required" }, 403)
    const membership = await hostedMembership(input, auth)
    if (!membership) return c.json({ code: "connections_org_membership_required" }, 403)
    // Entitlement is an org-billing concept, so it is checked against the org
    // the authority resolved — never a claim the caller supplied.
    const denied = await input.requireEntitlement?.(membership.orgId)
    if (denied) return c.json(denied.body, denied.status)

    const attempts = input.attempts ?? d1Attempts(input)
    // `GET /attempts/:state` is served from the CALLER's partitions, so the
    // attempt it names must belong to them. The kit's route cannot check this:
    // it knows nothing about orgs. Without the check a signed caller holding
    // any state token reads another tenant's attempt — and, for a device grant,
    // POLLING IS WHAT ADVANCES IT, so the poll would drive a stranger's grant
    // to completion. Same frozen owner/routing agreement `hostedCallback`
    // requires, and the same 404 the kit answers for an unknown state, so a
    // prober cannot tell "not yours" from "not there".
    const attemptState = /^\/attempts\/([^/]+)$/.exec(subpath)?.[1]
    if (attemptState !== undefined) {
      const frozen = await attempts.ownership(decodeURIComponent(attemptState))
      const owned = frozen?.owner === `user:${membership.userId}` || frozen?.owner === `org:${membership.orgId}`
      if (!frozen || !owned || frozen.routing?.org_id !== membership.orgId) {
        return c.json({ code: "attempt_not_found" }, 404)
      }
    }

    const integrationId = /^\/([^/]+)\/connect$/.exec(subpath)?.[1]
    const service = await hostedConnectionsService(input, {
      ownerUserId: membership.userId,
      orgId: membership.orgId,
      attempts,
      ...(integrationId ? { integrationId } : {}),
      auth,
      request: c.req.raw,
    })
    // NOT disposed: `service.dispose()` disposes the ATTEMPT store, and on this
    // path the attempt that was just created has to outlive the request that
    // created it. The durable D1 store's `dispose` is a no-op for exactly that
    // reason; disposing here would still destroy an injected in-memory store.
    const routes = createIntegrationsRoutes(service, {
      owner: () => `user:${membership.userId}`,
      teamOwner: () => `org:${membership.orgId}`,
      attemptRouting: () => ({ org_id: membership.orgId, owner_user_id: membership.userId }),
      teamWriteGate: (context) =>
        TEAM_WRITE_ROLES.has(membership.role) ? null : context.json({ code: "connections_org_admin_required" }, 403),
      ownerlessRows: "refuse",
    })
    // Two concurrent connects both find no existing row, both mint a fresh id,
    // and the loser trips the partition's unique index. The kit decides
    // `connection_exists` from a RETURNED code, so a store that discovers the
    // duplicate only at write time can reach the client no other way than this
    // — and without it the race surfaced as a bare 500. Anything else is a real
    // fault and is rethrown to the enclosing app unchanged.
    routes.onError((cause, context) => {
      if (cause instanceof HostedConnectionExistsError) {
        return context.json({ ok: false, code: "connection_exists" }, 409)
      }
      throw cause
    })
    const url = new URL(c.req.url)
    url.pathname = subpath
    const response = await routes.fetch(new Request(url, c.req.raw))
    // Attempt retention has no cron: this request path is the only thing that
    // can retire a row, so a sampled pass is what keeps the table bounded. It
    // runs AFTER the answer is produced, and a failed sweep is maintenance
    // debt rather than a reason to fail a request the user already completed.
    if (input.sweepSample?.() ?? Math.random() < HOSTED_ATTEMPT_SWEEP_RATE) {
      await Promise.resolve(attempts.sweep()).catch(() => undefined)
    }
    return response
  }
  app.all("/", handle)
  app.all("/*", handle)
  return app
}

async function hostedCallback(input: HostedD1ConnectionsSetupInput, c: Context, subpath: string) {
  const state = c.req.query("state") ?? ""
  const attempts = input.attempts ?? d1Attempts(input)
  const pending = state ? await attempts.inspect(state) : undefined
  const orgId = pending?.routing?.org_id
  const ownerUserId = pending?.routing?.owner_user_id
  // The owner key frozen into the attempt must agree with the routing frozen
  // beside it. A callback URL is public; nothing it carries is trusted beyond
  // the state token that selects this row.
  const ownerMatches = pending?.scope === "personal"
    ? pending.owner === `user:${ownerUserId}`
    : pending?.scope === "team" && pending.owner === `org:${orgId}`
  if (!orgId || !ownerUserId || !ownerMatches) return c.html(CALLBACK_FAILURE_PAGE, 400)
  const service = await hostedConnectionsService(input, {
    ownerUserId,
    orgId,
    attempts,
    integrationId: pending.integrationId,
    // The attempt froze which partition this callback settles into, so the
    // existing row is looked up in THAT partition rather than in whichever of
    // the two happens to sort first.
    ...(pending.owner !== undefined ? { owner: pending.owner } : {}),
    ...(pending.context ? { attemptContext: pending.context } : {}),
  })
  const routes = createIntegrationsRoutes(service, { ownerlessRows: "refuse" })
  const url = new URL(c.req.url)
  url.pathname = subpath
  return await routes.fetch(new Request(url, c.req.raw))
}

/**
 * Hosted counterpart of the local `repositoryForAuth` (connections/index.ts):
 * proves the signed caller can read `fullName` through their org's code-host
 * connection and mints the clone token. Used by the hosted workspace-create
 * route so connected private repositories provision exactly like they do on the
 * local control plane. A fresh per-request service, like `handle` above —
 * connection metadata and credentials are org-scoped reads, not process state.
 */
export function createHostedRepositoryAccess(input: HostedD1ConnectionsSetupInput) {
  return async (auth: SignedControlPlaneAuth | undefined, connectionId: string, fullName: string) => {
    if (!auth) return { ok: false as const, status: 403 as const, code: "connections_org_required" }
    const membership = await hostedMembership(input, auth)
    if (!membership) return { ok: false as const, status: 403 as const, code: "connections_org_membership_required" }
    const service = await hostedConnectionsService(input, { ownerUserId: membership.userId, orgId: membership.orgId })
    try {
      const visible = (await service.list({ teamOwner: `org:${membership.orgId}`, scope: "team" }))
        .some((connection) => connection.id === connectionId)
      if (!visible) return { ok: false as const, status: 404 as const, code: "connection_not_found" }
      const listed = await service.listRepositories(connectionId)
      if (!listed.ok) return listed
      const repository = listed.repositories.find((item) => item.fullName === fullName)
      if (!repository) return { ok: false as const, status: 404 as const, code: "repository_not_found" }
      if (!repository.permissions.read) {
        return { ok: false as const, status: 403 as const, code: "repository_read_required" }
      }
      const token = await service.getToken(connectionId, "code-host")
      if (!token.ok) return token
      return { ok: true as const, repository, token: token.response.token }
    } finally {
      service.dispose()
    }
  }
}

type CapabilityRequest = Readonly<{
  ownerUserId: string
  orgId: string
  integrationId: string
  capability: IntegrationCapability
}>

/**
 * Runtime-only capability resolution for a caller whose internal user/org
 * identity has already been verified by its own audience-bound credential.
 * The result is obtained from Connections at call time so refresh and
 * personal-over-organization selection stay in their canonical owner.
 */
export function createHostedCapabilityTokenResolver(input: HostedD1ConnectionsSetupInput) {
  return async (request: CapabilityRequest) => {
    const service = await hostedConnectionsService(input, {
      ownerUserId: request.ownerUserId,
      orgId: request.orgId,
      integrationId: request.integrationId,
    })
    try {
      const [connection] = await service.resolveForCapability(request.capability, {
        owner: `user:${request.ownerUserId}`,
        teamOwner: `org:${request.orgId}`,
        integration: request.integrationId,
      })
      if (!connection) return { ok: false as const, status: 404 as const, code: "connection_not_found" }
      const token = await connection.getToken()
      return { ok: true as const, connectionId: connection.id, ...token }
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause && "code" in cause) {
        const error = cause as { status: 403 | 404 | 409 | 503; code: string }
        return { ok: false as const, status: error.status, code: error.code }
      }
      throw cause
    } finally {
      service.dispose()
    }
  }
}

/** Secret-free runtime readiness. It selects the same personal-over-org handle without resolving a token. */
export function createHostedCapabilityConnectionResolver(input: HostedD1ConnectionsSetupInput) {
  return async (request: CapabilityRequest) => {
    const service = await hostedConnectionsService(input, {
      ownerUserId: request.ownerUserId,
      orgId: request.orgId,
      integrationId: request.integrationId,
    })
    try {
      const [connection] = await service.resolveForCapability(request.capability, {
        owner: `user:${request.ownerUserId}`,
        teamOwner: `org:${request.orgId}`,
        integration: request.integrationId,
      })
      if (!connection) return { ok: false as const, status: 404 as const, code: "connection_not_found" }
      return {
        ok: true as const,
        connectionId: connection.id,
        integrationId: connection.integrationId,
        scope: connection.scope,
        fields: connection.fields,
      }
    } finally {
      service.dispose()
    }
  }
}

/** Mark the exact selected Connection degraded after an upstream auth rejection. */
export function createHostedCapabilityAuthFailureReporter(input: HostedD1ConnectionsSetupInput) {
  return async (request: CapabilityRequest & { connectionId: string }) => {
    const service = await hostedConnectionsService(input, {
      ownerUserId: request.ownerUserId,
      orgId: request.orgId,
      integrationId: request.integrationId,
    })
    try {
      const handles = await service.resolveForCapability(request.capability, {
        owner: `user:${request.ownerUserId}`,
        teamOwner: `org:${request.orgId}`,
        integration: request.integrationId,
      })
      const connection = handles.find((candidate) => candidate.id === request.connectionId)
      if (connection) await connection.reportAuthFailure("upstream_authorization_rejected")
    } finally {
      service.dispose()
    }
  }
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Membership verdict for the signed caller.
 *
 * The application authority owns every fact here: `usersMe` maps the verified
 * principal to the canonical `user_id` (and to the org, when the user belongs to
 * exactly one), `resolveOrgId` is the explicit fallback, and `listOrgs` supplies
 * the role that gates organization-scope writes. Nothing is read from a token
 * claim, so a caller cannot name an org it does not belong to. An authority
 * denial (no membership, or an ambiguous multi-org session with no selection)
 * resolves to "no membership", which the routes answer 403.
 */
async function hostedMembership(
  input: HostedD1ConnectionsSetupInput,
  auth: SignedControlPlaneAuth,
): Promise<HostedMembership | undefined> {
  const authority: WorkspaceAuthority | undefined = input.services.authority
  if (!authority) return undefined
  try {
    const me = recordValue(await authority.usersMe(auth))
    const userId = textValue(me?.user_id)
    if (!userId) return undefined
    const orgId = textValue(me?.org_id) ?? textValue(await authority.resolveOrgId(auth))
    if (!orgId) return undefined
    const orgs = await authority.listOrgs(auth)
    const membership = Array.isArray(orgs)
      ? orgs.map(recordValue).find((row) => textValue(row?.org_id) === orgId)
      : undefined
    return { userId, orgId, role: textValue(membership?.role) ?? "member" }
  } catch (cause) {
    // `resolveOrgId` denies with a control-plane auth error when the caller has
    // no organization or an ambiguous one; both mean the same thing here.
    if (cause instanceof ControlPlaneAuthError) return undefined
    throw cause
  }
}

function d1Attempts(input: HostedD1ConnectionsSetupInput) {
  return createD1ConnectionAttempts({
    database: input.database,
    ...(input.now ? { now: input.now } : {}),
  })
}

/** One tenant service. `owner` names the partition when the caller knows it. */
type HostedConnectionsServiceRequest = Readonly<{
  ownerUserId: string
  orgId: string
  integrationId?: string
  auth?: SignedControlPlaneAuth
  attemptContext?: Readonly<Record<string, string>>
  request?: Request
  /** The attempt store this request already built, so one request opens one. */
  attempts?: HostedConnectionAttempts
  /** The partition an attempt froze. Absent for runtime resolution, which selects it below. */
  owner?: string
}>

async function hostedConnectionsService(
  input: HostedD1ConnectionsSetupInput,
  request: HostedConnectionsServiceRequest,
) {
  const { ownerUserId, orgId, integrationId, auth, attemptContext, owner } = request
  const connections = createD1ConnectionStore({
    database: input.database,
    orgId,
    ownerUserId,
    ...(input.now ? { now: input.now } : {}),
  })
  // A callback and a runtime resolution arrive with no caller context, so the
  // dynamic provider rebuilds its refresh behavior from the stored row's public
  // canonical fields instead.
  //
  // The partition is named rather than searched: a callback carries the owner
  // its attempt froze, and a runtime resolution reads personal-before-team —
  // the SAME precedence `service.resolveForCapability` uses to pick the row
  // whose token will actually be served. Scanning both partitions and taking
  // whichever sorts first could rebuild the refresh behavior from the org row
  // while the runtime resolved the personal one.
  const existingFor = async () => {
    if (!integrationId || auth || attemptContext) return undefined
    if (owner !== undefined) return connections.get(integrationId, owner)
    return (
      (await connections.get(integrationId, `user:${ownerUserId}`)) ??
      (await connections.get(integrationId, `org:${orgId}`))
    )
  }
  const existing = await existingFor()
  const registry = createIntegrationRegistry()
  for (const integration of input.integrations ?? [githubIntegrationForEnv(input.env), linearIntegration(), atlassianIntegration()]) {
    registry.register(integration.decl, integration.impl)
  }
  for (const integration of await input.dynamicIntegrations?.({
    ownerUserId,
    orgId,
    ...(integrationId ? { integrationId } : {}),
    ...(auth ? { auth } : {}),
    ...(attemptContext ? { attemptContext } : {}),
    ...(existing ? { connectionFields: existing.fields } : {}),
    ...(request.request ? { request: request.request } : {}),
  }) ?? []) {
    registry.register(integration.decl, integration.impl)
  }
  return createConnectionsService({
    registry,
    credentials: credentialStore(input.credentials?.(orgId) ?? hostedOrgCredentials(orgId, input.env)),
    connections,
    // The service is built PER REQUEST, so the kit's default in-memory attempt
    // store is empty on every call after the one that created the attempt:
    // `POST /:id/connect` wrote into one isolate's Map and `GET /attempts/:state`
    // read a different, empty one, so every hosted OAuth/device connect answered
    // `attempt_not_found` and could never complete. A durable store is what makes
    // an attempt outlive its request.
    attempts: request.attempts ?? input.attempts ?? d1Attempts(input),
    newId: () => crypto.randomUUID(),
    ...(input.now ? { now: input.now } : {}),
  })
}

/** Adapts the per-org encrypted credential surface to the kit's credential port. */
function credentialStore(credentials: ControlPlaneCredentials): CredentialStorePort {
  const resolveSecret = credentials.resolveCredentialSecret
  if (!resolveSecret) throw new Error("Hosted Connections requires credential secret resolution")
  // The status-independent read seam. In this per-org store the metadata id IS
  // the provider id (`credentials/worker/index.ts`), so a provider id addresses
  // the record directly.
  const readSecretById = credentials.resolveCredentialSecretById
  if (!readSecretById) throw new Error("Hosted Connections requires status-independent credential reads")
  return {
    async put(value) {
      await credentials.putCredential({
        provider_id: value.providerId,
        kind: value.kind,
        source: "managed",
        secret: value.secret,
        ...(value.expiresAt === undefined ? {} : { expires_at: value.expiresAt }),
      })
    },
    async get(providerId) {
      const value = await credentials.getCredentialByProvider(providerId)
      if (!value || (value.kind !== "api_key" && value.kind !== "oauth_token")) return undefined
      return {
        kind: value.kind,
        status: value.status,
        ...(value.expires_at === null || value.expires_at === undefined ? {} : { expiresAt: value.expires_at }),
      }
    },
    resolveSecret,
    // The port defines this as "the stored secret regardless of status" and
    // re-verify is its only caller. Reading it must therefore not decide the
    // credential is healthy: flipping a revoked or errored row to `available`
    // made a failing re-verify LOOK like a repair, and left the token path
    // serving a credential the provider had already rejected.
    readSecret: (providerId) => readSecretById(providerId),
    async setStatus(providerId, status, lastError) {
      const value = await credentials.getCredentialByProvider(providerId)
      if (value) await credentials.updateCredentialStatus(value.id, status, lastError)
    },
    deleteByProvider: async (providerId) => { await credentials.deleteCredentialsByProvider(providerId) },
  }
}
