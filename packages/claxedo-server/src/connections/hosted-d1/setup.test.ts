import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import type { IntegrationDeclaration, IntegrationImpl } from "@claxedo/connections"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import {
  createD1ConnectionAttempts,
  HOSTED_ATTEMPT_RETENTION_MS,
  HOSTED_ATTEMPT_TTL_MS,
} from "./attempts"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../../authority/services"
import {
  createHostedCapabilityAuthFailureReporter,
  createHostedCapabilityConnectionResolver,
  createHostedCapabilityTokenResolver,
  createHostedD1ConnectionsSetup,
  createHostedRepositoryAccess,
  type HostedD1ConnectionsSetupInput,
} from "./setup"

// The authority migrations (as `workspace-authority.test.ts` applies them) plus
// the two Agent Plugins ones, so the applied order matches production. 0018 and
// 0019 are inert for this suite — 0018's `drop ... if exists` targets 0005's
// tables, which this slice does not create, and nothing here reads an
// activation row — but running them proves 0020 composes after them.
const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0013_org_team_session_sharing.sql",
  "0017_adapter_custom.sql",
  "0018_drop_agent_extensions.sql",
  "0019_agent_plugin_activations.sql",
  "0020_hosted_connections.sql",
]

const NOW = 1_900_000_000_000
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://better-auth.example.test", subject }
}

/** The signed shape the authority verifies: a real application principal, not a token claim. */
async function signed(authority: D1WorkspaceAuthority, applicationIdentity: AuthIdentity): Promise<SignedControlPlaneAuth> {
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${applicationIdentity.subject}`,
    authenticatedAt: NOW,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity: applicationIdentity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject: applicationIdentity.subject,
      tokenIdentifier: `${applicationIdentity.issuer}|${applicationIdentity.subject}`,
      issuer: applicationIdentity.issuer,
    },
  }
}

type CredentialFake = ControlPlaneCredentials & {
  statusOf(providerId: string): string | undefined
  secretOf(providerId: string): string | undefined
}

/** A `ControlPlaneCredentials` over a Map, standing in for the encrypted per-org KV store. */
function credentialFake(): CredentialFake {
  const rows = new Map<string, { secret: string; status: "available" | "expired" | "revoked" | "error" }>()
  const meta = (providerId: string) => {
    const row = rows.get(providerId)
    if (!row) return undefined
    return {
      id: providerId,
      provider_id: providerId,
      kind: "api_key" as const,
      source: "managed" as const,
      label: null,
      account_id: null,
      secure_ref: `test:${providerId}`,
      status: row.status,
      health: null,
      expires_at: null,
      last_validated_at: null,
      last_error: null,
      created_at: NOW,
      updated_at: NOW,
    }
  }
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async (providerId) => meta(providerId),
    resolveCredentialSecret: async (providerId) => {
      const row = rows.get(providerId)
      return row && row.status === "available" ? row.secret : null
    },
    // The metadata id IS the provider id in the per-org hosted store, so this
    // is the status-independent read `readSecret` is built on.
    resolveCredentialSecretById: async (id) => rows.get(id)?.secret ?? null,
    putCredential: async (value) => {
      rows.set(value.provider_id, { secret: value.secret, status: "available" })
      return meta(value.provider_id)!
    },
    deleteCredential: async (id) => rows.delete(id),
    deleteCredentialsByProvider: async (providerId) => (rows.delete(providerId) ? 1 : 0),
    updateCredentialStatus: async (id, status) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, status })
    },
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    statusOf: (providerId) => rows.get(providerId)?.status,
    secretOf: (providerId) => rows.get(providerId)?.secret,
  }
}

const keyIntegration: { decl: IntegrationDeclaration; impl: IntegrationImpl } = {
  decl: {
    id: "context7",
    name: "Context7",
    methods: ["key"],
    capabilities: ["mcp"],
    prompts: [{ id: "token", label: "API key", secret: true }],
    // The token service refuses an api_key credential whose declaration does
    // not say how the key is presented on the wire.
    keyTokenType: "bearer",
  },
  impl: { verify: async () => ({ ok: true, accountLabel: "context7-account" }) },
}

const oauthIntegration: { decl: IntegrationDeclaration; impl: IntegrationImpl } = {
  decl: { id: "composio", name: "Composio", methods: ["oauth"], capabilities: ["mcp"] },
  impl: {
    authorize: (state) => new URL(`https://composio.example.test/authorize?state=${state}`),
    callback: async () => ({ accessToken: "composio-access" }),
  },
}

/**
 * Two real users in ONE organization.
 *
 * The `user-deployed` product is what makes that shape reachable: it owns a
 * single deployment organization and admits members into it, so both callers
 * belong to exactly one org and `usersMe` resolves it without an explicit
 * selection — the resolution the setup depends on.
 */
type RigOptions = {
  integrations?: ReadonlyArray<{ decl: IntegrationDeclaration; impl: IntegrationImpl }>
  /** Forces or suppresses the per-request attempt-retention pass. */
  sweepSample?: () => boolean
}

async function rig(options: RigOptions = {}) {
  const target = await database()
  const ownerIdentity = identity("owner")
  let sequence = 0
  const authority = new D1WorkspaceAuthority(target, {
    deploymentId: "deployment-a",
    product: {
      kind: "user-deployed",
      organization: { id: "org_deployment", name: "Deployment" },
      ownerIdentity,
    },
    now: () => NOW + sequence,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const owner = await signed(authority, ownerIdentity)
  const memberIdentity = identity("member")
  const admission = await authority.admitUserDeployedIdentity(owner, { identity: memberIdentity, role: "member" })
  if (admission.state !== "active") throw new Error("the deployment member was not admitted")
  const member = await signed(authority, memberIdentity)

  const credentials = credentialFake()
  // The setup's clock, movable so an attempt TTL is crossed exactly rather
  // than waited out.
  let clock = NOW
  // The setup reads nothing else off `services`; the authority IS the
  // membership oracle this composition is built on.
  const services = { authority } as unknown as ControlPlaneServices
  let actor: SignedControlPlaneAuth | undefined = owner
  const input: HostedD1ConnectionsSetupInput = {
    env: {},
    database: target,
    services,
    authenticate: async () => (actor ? { auth: actor } : {}),
    integrations: options.integrations ?? [keyIntegration, oauthIntegration],
    credentials: () => credentials,
    ...(options.sweepSample ? { sweepSample: options.sweepSample } : { sweepSample: () => false }),
    now: () => clock,
  }
  return {
    authority,
    database: target,
    credentials,
    input,
    owner,
    member,
    app: createHostedD1ConnectionsSetup(input),
    as(next: SignedControlPlaneAuth | undefined) {
      actor = next
    },
    ownerUserId: owner.principal!.userId,
    memberUserId: member.principal!.userId,
    advance(ms: number) {
      clock += ms
    },
  }
}

const connect = (app: ReturnType<typeof createHostedD1ConnectionsSetup>, integrationId: string, body: unknown) =>
  app.request(`/${integrationId}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const listed = async (app: ReturnType<typeof createHostedD1ConnectionsSetup>) =>
  (await (await app.request("/")).json()) as { connections: Array<{ id: string; integrationId: string; scope: string; status: string }> }

describe("hosted D1 Connections setup", () => {
  test("a personal connection belongs to the user who made it and to no one else", async () => {
    const test = await rig()

    expect((await connect(test.app, "context7", { scope: "personal", secret: "owner-key" })).status).toBe(200)

    const ownerView = await listed(test.app)
    expect(ownerView.connections).toMatchObject([
      { integrationId: "context7", scope: "personal", status: "connected", accountLabel: "context7-account" },
    ])

    test.as(test.member)
    expect((await listed(test.app)).connections).toEqual([])
    // Even holding the row's id, the other user cannot reach it.
    const id = ownerView.connections[0].id
    expect((await test.app.request(`/connections/${id}`, { method: "DELETE" })).status).toBe(404)

    // The secret never reached the connection row.
    const stored = await test.database
      .prepare(`select owner_user_id, integration_id from hosted_connections`)
      .all<{ owner_user_id: string | null; integration_id: string }>()
    expect(stored.results).toEqual([{ owner_user_id: test.ownerUserId, integration_id: "context7" }])
    expect(JSON.stringify(stored.results)).not.toContain("owner-key")
    expect(test.credentials.secretOf(`integration:${id}`)).toBe("owner-key")
  })

  test("an organization-scope write needs an org admin; a plain member is refused", async () => {
    const test = await rig()

    test.as(test.member)
    const refused = await connect(test.app, "context7", { scope: "team", secret: "member-key" })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ code: "connections_org_admin_required" })

    test.as(test.owner)
    expect((await connect(test.app, "context7", { scope: "team", secret: "org-key" })).status).toBe(200)

    // The organization row is the member's too — that is the point of the scope.
    test.as(test.member)
    expect((await listed(test.app)).connections).toMatchObject([{ integrationId: "context7", scope: "team" }])
  })

  test("an unsigned request is refused before any authority or store read", async () => {
    const test = await rig()
    test.as(undefined)

    const response = await test.app.request("/")

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: "connections_org_required" })
  })

  test("capability resolution prefers the caller's personal connection over the organization one", async () => {
    const test = await rig()
    test.as(test.owner)
    await connect(test.app, "context7", { scope: "team", secret: "org-key" })
    await connect(test.app, "context7", { scope: "personal", secret: "owner-key" })
    const rows = await test.database
      .prepare(`select connection_id, owner_user_id from hosted_connections order by owner_user_id is null`)
      .all<{ connection_id: string; owner_user_id: string | null }>()
    const personal = rows.results.find((row) => row.owner_user_id !== null)!.connection_id
    const organization = rows.results.find((row) => row.owner_user_id === null)!.connection_id

    const resolveConnection = createHostedCapabilityConnectionResolver(test.input)
    const scope = { orgId: "org_deployment", integrationId: "context7", capability: "mcp" as const }

    expect(await resolveConnection({ ...scope, ownerUserId: test.ownerUserId })).toMatchObject({
      ok: true,
      connectionId: personal,
      scope: "personal",
    })
    // The member has no personal row, so the organization one serves their runtime.
    expect(await resolveConnection({ ...scope, ownerUserId: test.memberUserId })).toMatchObject({
      ok: true,
      connectionId: organization,
      scope: "team",
    })
    expect(await resolveConnection({ ...scope, ownerUserId: test.memberUserId, integrationId: "composio" })).toEqual({
      ok: false,
      status: 404,
      code: "connection_not_found",
    })
  })

  test("the token resolver serves the selected connection's secret and the failure reporter degrades that exact row", async () => {
    const test = await rig()
    test.as(test.owner)
    await connect(test.app, "context7", { scope: "team", secret: "org-key" })
    await connect(test.app, "context7", { scope: "personal", secret: "owner-key" })
    const rows = await test.database
      .prepare(`select connection_id, owner_user_id from hosted_connections`)
      .all<{ connection_id: string; owner_user_id: string | null }>()
    const personal = rows.results.find((row) => row.owner_user_id !== null)!.connection_id
    const organization = rows.results.find((row) => row.owner_user_id === null)!.connection_id
    const scope = {
      ownerUserId: test.ownerUserId,
      orgId: "org_deployment",
      integrationId: "context7",
      capability: "mcp" as const,
    }

    expect(await createHostedCapabilityTokenResolver(test.input)(scope)).toEqual({
      ok: true,
      connectionId: personal,
      token: "owner-key",
      tokenType: "bearer",
    })

    await createHostedCapabilityAuthFailureReporter(test.input)({ ...scope, connectionId: personal })

    // Exactly the selected row is degraded; the organization credential is untouched.
    expect(test.credentials.statusOf(`integration:${personal}`)).toBe("error")
    expect(test.credentials.statusOf(`integration:${organization}`)).toBe("available")
    expect((await listed(test.app)).connections.find((row) => row.id === personal)?.status).toBe("degraded")
  })

  test("an OAuth attempt created by one service instance is found by the next — the durability the in-memory store cannot give", async () => {
    const test = await rig()
    test.as(test.owner)

    const started = await connect(test.app, "composio", { method: "oauth", scope: "personal" })
    expect(started.status).toBe(200)
    const attempt = (await started.json()) as { ok: true; url: string; attemptId: string }
    expect(attempt.url).toContain(attempt.attemptId)

    // A second setup over the same database stands in for the next request's
    // isolate — the one that used to read an empty Map and answer 404.
    const next = createHostedD1ConnectionsSetup(test.input)
    const polled = await next.request(`/attempts/${attempt.attemptId}`)
    expect(polled.status).toBe(200)
    expect(await polled.json()).toEqual({ status: "pending", integrationId: "composio", scope: "personal" })

    // The routing frozen into the attempt is what lets the unauthenticated
    // provider redirect select this caller's tenant service.
    const callback = await next.request(`/callback?state=${attempt.attemptId}&code=grant-code`)
    expect(callback.status).toBe(200)
    expect(callback.headers.get("content-type")).toContain("text/html")
    const stored = await test.database
      .prepare(`select owner_user_id, integration_id from hosted_connections`)
      .all<{ owner_user_id: string | null; integration_id: string }>()
    expect(stored.results).toEqual([{ owner_user_id: test.ownerUserId, integration_id: "composio" }])

    // A fabricated state settles nothing.
    expect((await next.request("/callback?state=not-an-attempt&code=grant-code")).status).toBe(400)
  })

  test("the routes answer the same way mounted at /api/claxedo/integrations as standalone", async () => {
    // The mount point is not hard-coded: the subpath is derived from the route
    // Hono actually matched, so a callback still reaches `/callback` after
    // `app.route(prefix, setup)` re-registers every route under the prefix.
    const test = await rig()
    test.as(test.owner)
    const mounted = new Hono().route("/api/claxedo/integrations", test.app)

    expect((await mounted.request("/api/claxedo/integrations")).status).toBe(200)
    const started = await mounted.request("/api/claxedo/integrations/composio/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "oauth", scope: "team" }),
    })
    expect(started.status).toBe(200)
    const attempt = (await started.json()) as { attemptId: string }

    const polled = await mounted.request(`/api/claxedo/integrations/attempts/${attempt.attemptId}`)
    expect(await polled.json()).toMatchObject({ status: "pending", integrationId: "composio", scope: "team" })

    const callback = await mounted.request(`/api/claxedo/integrations/callback?state=${attempt.attemptId}&code=grant-code`)
    expect(callback.status).toBe(200)
    expect((await listed(test.app)).connections).toMatchObject([{ integrationId: "composio", scope: "team" }])
  })

  test("repository access refuses a connection id from another partition", async () => {
    const test = await rig()
    test.as(test.member)
    await connect(test.app, "context7", { scope: "personal", secret: "member-key" })
    const foreign = (await test.database
      .prepare(`select connection_id from hosted_connections`)
      .first<{ connection_id: string }>())!.connection_id

    const repositoryForAuth = createHostedRepositoryAccess(test.input)

    expect(await repositoryForAuth(test.owner, foreign, "octocat/repo")).toEqual({
      ok: false,
      status: 404,
      code: "connection_not_found",
    })
    expect(await repositoryForAuth(undefined, foreign, "octocat/repo")).toEqual({
      ok: false,
      status: 403,
      code: "connections_org_required",
    })
  })
  test("polling an attempt is refused unless the attempt is the caller's own", async () => {
    // `GET /attempts/:state` is served from the CALLER's partitions and the
    // kit's route knows nothing about orgs, so without a gate here a signed
    // caller holding any state token reads another tenant's attempt — and for a
    // device grant, polling is what ADVANCES it.
    const test = await rig()
    test.as(test.member)
    const started = await connect(test.app, "composio", { method: "oauth", scope: "personal" })
    const attempt = (await started.json()) as { attemptId: string }
    expect((await test.app.request(`/attempts/${attempt.attemptId}`)).status).toBe(200)

    // A different signed user in the SAME organization, holding the token.
    test.as(test.owner)
    const foreign = await test.app.request(`/attempts/${attempt.attemptId}`)
    expect(foreign.status).toBe(404)
    // Indistinguishable from a state that never existed, so probing tells a
    // caller nothing about which tokens are live.
    expect(await foreign.json()).toEqual({ code: "attempt_not_found" })
    const unknown = await test.app.request("/attempts/not-an-attempt")
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ code: "attempt_not_found" })

    // An owner key alone is not enough: the routing frozen beside it has to
    // name this caller's organization too.
    const attempts = createD1ConnectionAttempts({ database: test.database, now: () => NOW })
    const crossOrg = await attempts.create({
      integrationId: "composio",
      owner: "org:org_deployment",
      scope: "team",
      routing: { org_id: "org-elsewhere", owner_user_id: test.ownerUserId },
    })
    expect((await test.app.request(`/attempts/${crossOrg.state}`)).status).toBe(404)

    // The caller's own attempts — personal and organization — still poll.
    const personal = (await (await connect(test.app, "composio", { method: "oauth", scope: "personal" })).json()) as {
      attemptId: string
    }
    expect((await test.app.request(`/attempts/${personal.attemptId}`)).status).toBe(200)
    const team = (await (await connect(test.app, "composio", { method: "oauth", scope: "team" })).json()) as {
      attemptId: string
    }
    expect((await test.app.request(`/attempts/${team.attemptId}`)).status).toBe(200)
  })

  test("an attempt past its TTL reads expired and settles nothing", async () => {
    const test = await rig()
    test.as(test.owner)
    const started = await connect(test.app, "composio", { method: "oauth", scope: "personal" })
    const attempt = (await started.json()) as { attemptId: string }

    test.advance(HOSTED_ATTEMPT_TTL_MS)

    const polled = await test.app.request(`/attempts/${attempt.attemptId}`)
    expect(polled.status).toBe(200)
    expect(await polled.json()).toEqual({ status: "expired", integrationId: "composio", scope: "personal" })
    // Derived, not written: with the sweep suppressed nothing has retired the
    // row yet, so the answer comes from the TTL alone.
    const stored = await test.database
      .prepare(`select status from hosted_connection_attempts where state = ?`)
      .bind(attempt.attemptId)
      .first<{ status: string }>()
    expect(stored).toEqual({ status: "pending" })

    // A provider redirect arriving after the deadline settles nothing: an
    // expired attempt is not consumable, so no connection is written.
    const callback = await test.app.request(`/callback?state=${attempt.attemptId}&code=grant-code`)
    expect(callback.status).toBe(400)
    expect((await listed(test.app)).connections).toEqual([])
  })

  test("the request path is what retires attempts — there is no cron on the table", async () => {
    const test = await rig({ sweepSample: () => true })
    test.as(test.owner)
    const started = await connect(test.app, "composio", { method: "oauth", scope: "personal" })
    const attempt = (await started.json()) as { attemptId: string }
    const rows = async () =>
      (await test.database
        .prepare(`select state, status from hosted_connection_attempts`)
        .all<{ state: string; status: string }>()).results

    // The connect's own sweep had nothing to retire.
    expect(await rows()).toEqual([{ state: attempt.attemptId, status: "pending" }])

    test.advance(HOSTED_ATTEMPT_TTL_MS)
    expect((await test.app.request("/")).status).toBe(200)
    // Expired rather than deleted: a client that polls once more still learns
    // why its attempt ended.
    expect(await rows()).toEqual([{ state: attempt.attemptId, status: "expired" }])

    test.advance(HOSTED_ATTEMPT_RETENTION_MS)
    expect((await test.app.request("/")).status).toBe(200)
    expect(await rows()).toEqual([])
    expect((await test.app.request(`/attempts/${attempt.attemptId}`)).status).toBe(404)
  })

  test("a connect that loses the one-row-per-partition race answers connection_exists, not a 500", async () => {
    const test = await rig()
    test.as(test.owner)
    let planted = false
    // The credential write is the one seam between the service's existing-row
    // read and its upsert, so planting there reproduces the exact interleaving
    // a second concurrent connect creates: both requests saw no row, both
    // minted a fresh id, and the loser trips the partition's unique index.
    const app = createHostedD1ConnectionsSetup({
      ...test.input,
      credentials: () => ({
        ...test.credentials,
        putCredential: async (value) => {
          if (!planted) {
            planted = true
            await test.database
              .prepare(
                `insert into hosted_connections (
                   connection_id, org_id, owner_user_id, integration_id,
                   granted_capabilities_json, fields_json, account_label, created_at, updated_at
                 ) values ('conn-winner', 'org_deployment', ?, 'context7', '["mcp"]', '{}', null, ?, ?)`,
              )
              .bind(test.ownerUserId, NOW, NOW)
              .run()
          }
          return test.credentials.putCredential(value)
        },
      }),
    })

    const response = await connect(app, "context7", { scope: "personal", secret: "loser-key" })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, code: "connection_exists" })
    // The winner's row is untouched and still the only one.
    const stored = await test.database
      .prepare(`select connection_id, integration_id from hosted_connections`)
      .all<{ connection_id: string; integration_id: string }>()
    expect(stored.results).toEqual([{ connection_id: "conn-winner", integration_id: "context7" }])
  })

  test("re-verify reads a degraded credential without pronouncing it healthy", async () => {
    let healthy = true
    const flaky: { decl: IntegrationDeclaration; impl: IntegrationImpl } = {
      decl: keyIntegration.decl,
      impl: {
        verify: async () =>
          healthy
            ? { ok: true as const, accountLabel: "context7-account" }
            : { ok: false as const, reason: "unauthorized" as const },
      },
    }
    const test = await rig({ integrations: [flaky] })
    test.as(test.owner)
    await connect(test.app, "context7", { scope: "personal", secret: "owner-key" })
    const id = (await listed(test.app)).connections[0].id
    const providerId = `integration:${id}`

    // The provider rejected this token, so the runtime degraded exactly this row.
    await createHostedCapabilityAuthFailureReporter(test.input)({
      ownerUserId: test.ownerUserId,
      orgId: "org_deployment",
      integrationId: "context7",
      capability: "mcp",
      connectionId: id,
    })
    expect(test.credentials.statusOf(providerId)).toBe("error")

    // Re-verify is the only caller of `readSecret`, and the port defines that
    // as a status-INDEPENDENT read. Reading must not decide the credential is
    // healthy: flipping it to `available` on the way in made a still-failing
    // re-verify look like a repair and put the token path back on a credential
    // the provider had already rejected.
    healthy = false
    const refused = await test.app.request(`/connections/${id}/reverify`, { method: "POST" })
    expect(refused.status).toBe(422)
    expect(test.credentials.statusOf(providerId)).toBe("error")
    expect((await listed(test.app)).connections[0].status).toBe("degraded")

    // A successful re-verify is what clears it.
    healthy = true
    expect((await test.app.request(`/connections/${id}/reverify`, { method: "POST" })).status).toBe(200)
    expect(test.credentials.statusOf(providerId)).toBe("available")
    expect((await listed(test.app)).connections[0].status).toBe("connected")
  })
})
