import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { createSandboxManager, type SandboxDriver } from "@claxedo/sandbox-manager"
import type { ControlPlanePrincipal, RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { AuthenticationError } from "@claxedo/server-core/platform/auth/authentication"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"
import { createD1CoreAuthority } from "../../authority/adapters/d1/core-authority"
import { recordRelayRuntimeToken } from "../../authority/relay-token-record"
import { UNUSED_DURABLE_SESSION_LOG, UNUSED_PROJECTION_STORE } from "../../authority/unavailable-session-stores"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../../authority/services"
import { hostedTasksRouteContributions } from "../../deployments/hosted-workerd/tasks-contributions"
import { orgSandboxDrivers } from "../../sandbox/org-sandbox-drivers"
import { createOrgSandboxManager } from "../../sandbox/org-sandbox-manager"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"

type Env = { CONTROL_PLANE_DB: D1Database }

const ISSUER = "https://auth.test"

/** What a runtime access token carries here: the principal the bridge dispatched as, for the fake runtime's registration call back. */
export type FixtureRuntimeToken = { workspaceId: string; actorId: string; actorKind: "human" | "agent"; principalKind: "user" | "service" }

function readyDriver(provisionFailures: Set<string>): SandboxDriver {
  return {
    id: "modal",
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
    },
    ensureHost: async (input) => {
      if (provisionFailures.delete(input.workspaceId)) throw new Error("the provider is out of capacity")
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://sandbox.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    },
  }
}

/**
 * The hosted Tasks routes the Worker entry mounts, over the real D1 control
 * plane, the real hosted bridge and a sandbox manager on the D1 lease store.
 * Faked: the sandbox provider, the person's sign-in, and the workspace
 * runtime behind the relay (answered by the test's outbound service).
 */
function compose(database: D1Database) {
  const authority = createD1CoreAuthority(database, { deploymentId: "test", product: { kind: "claxedo-hosted" } })
  const principals = new Map<string, ControlPlanePrincipal>()
  const provisionFailures = new Set<string>()
  const driver = readyDriver(provisionFailures)
  const leaseStore = createD1SandboxLeaseStore({ database })
  const drivers = orgSandboxDrivers({
    keys: { drivers: ["modal"], create: () => driver, chosenDriver: async () => undefined },
    credentials: () => ({
      listCredentials: async () => [
        { id: "cred_modal", owner: null, provider_id: "modal", kind: "sandbox_driver", status: "active", revision: 1, created_at: 0 },
      ],
      resolveCredentialSecretById: async () => JSON.stringify({ token: "modal-token" }),
    }) as unknown as ControlPlaneCredentials,
  })
  const sandbox = createOrgSandboxManager({
    leaseStore,
    drivers,
    workspaceOrg: async (workspaceId) => (await authority.resolveWorkspaceOwner?.(workspaceId))?.orgId,
    manager: (keyDriver) => createSandboxManager({ leaseStore, driver: keyDriver }),
  })
  const services = {
    authority,
    sessionHosts: authority,
    projectionStore: UNUSED_PROJECTION_STORE,
    durableSessionLog: UNUSED_DURABLE_SESSION_LOG,
    telemetry: { capture: () => {} },
    localExecution: { enabled: false },
    defaultHomeRegion: "us-east",
    sandbox: { sandboxManager: sandbox.manager, orgDriver: sandbox.orgDriver, workspaceDriver: sandbox.workspaceDriver },
    relay: {
      relayUrls: { "us-east": "https://relay.test" },
      provider: {
        mintRuntimeAccessToken: async (input: RelayTokenInput) => {
          const minted = { jti: crypto.randomUUID(), expiresAt: Date.now() + 600_000 }
          await recordRelayRuntimeToken(authority, { ...input, ...minted, token: "" })
          const claims: FixtureRuntimeToken = {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorKind: input.actorKind,
            principalKind: input.principalKind,
          }
          return { ...minted, token: btoa(JSON.stringify(claims)) }
        },
        getRelayEndpoint: async () => "https://relay.test",
      },
    },
  } as unknown as ControlPlaneServices
  const authentication: RequestAuthenticationAdapter = {
    descriptor: testRequestAuthenticationAdapter().descriptor,
    async authenticate(request) {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const principal = token ? principals.get(token) : undefined
      if (!principal) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      return principal
    },
  }
  const signedAs = (subject: string): SignedControlPlaneAuth => {
    const principal = principals.get(subject)
    if (!principal) throw new Error(`${subject} has not signed in`)
    return {
      mode: "signed",
      token: subject,
      user: { subject: principal.userId, tokenIdentifier: `${ISSUER}|${subject}`, issuer: ISSUER },
      principal,
    }
  }
  const app = new Hono()
  for (const contribution of hostedTasksRouteContributions({
    services,
    database,
    authentication,
    selectedCapabilities: { prepare: async () => ({}), apply: async () => undefined },
    sandboxEgress: { controlPlaneOrigin: "https://core.test" },
  })) {
    app.route(contribution.path, contribution.routes)
  }

  app.post("/__person", async (c) => {
    const { subject } = await c.req.json<{ subject: string }>()
    const identity = { adapter: "better-auth" as const, issuer: ISSUER, subject }
    const admitted = await authority.ensureApplicationIdentity(identity)
    if (admitted.state !== "active") return c.json({ error: admitted.state }, 409)
    principals.set(subject, {
      userId: admitted.userId,
      actorId: admitted.actorId,
      actorKind: "human",
      deploymentId: "test",
      sessionId: `session:${subject}`,
      authenticatedAt: Date.now(),
      methods: ["oauth:google"],
      assurance: "single-factor",
      identity,
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read", "workspace:write"],
        deploymentId: "test",
        adapter: identity.adapter,
        issuer: identity.issuer,
        tokenEndpointOrigin: identity.issuer,
        controlPlaneOrigin: "https://core.test",
      },
    })
    return c.json({ userId: admitted.userId })
  })

  app.post("/__workspace", async (c) => {
    const body = await c.req.json<{ subject: string; workspaceId: string; repoUrl: string; gitBranch: string }>()
    await authority.createCloudWorkspace(signedAs(body.subject), {
      workspaceId: body.workspaceId,
      displayName: body.workspaceId,
      repoUrl: body.repoUrl,
      gitBranch: body.gitBranch,
      remoteDirectory: "/workspace",
      homeRegion: "us-east",
    })
    const row = await database
      .prepare("select project_id, org_id from workspaces where workspace_id = ?")
      .bind(body.workspaceId)
      .first<{ project_id: string; org_id: string }>()
    return c.json({ projectId: row?.project_id, orgId: row?.org_id })
  })

  app.post("/__fail-provision", async (c) => {
    provisionFailures.add((await c.req.json<{ workspaceId: string }>()).workspaceId)
    return c.json({ ok: true })
  })

  app.post("/__register", async (c) => {
    const body = await c.req.json<{ token: string; operationId: string; sessionId: string; createdAt: number; updatedAt: number; title?: string }>()
    const token = JSON.parse(atob(body.token)) as FixtureRuntimeToken
    const principal = token.principalKind === "user"
      ? { principalKind: "user" as const, actorId: token.actorId, actorKind: "human" as const }
      : { principalKind: "service" as const, actorId: token.actorId, actorKind: "agent" as const }
    try {
      await authority.registerRuntimeSession({
        ...principal,
        operationId: body.operationId,
        sessionId: body.sessionId,
        workspaceId: token.workspaceId,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        ...(body.title ? { title: body.title } : {}),
      })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
    }
    return c.json({ allowed: true })
  })

  app.get("/__rows", async (c) => {
    const read = (sql: string) => database.prepare(sql).all().then((result) => result.results)
    return c.json({
      workspaces: await read("select workspace_id, project_id, backing, display_name, repo_url, git_branch, deleted_at from workspaces order by created_at"),
      sessions: await read("select session_id, workspace_id, project_id, deleted_at from sessions"),
      links: await read("select task_id, slot, attempt, session_id, session_workspace_id, placement from task_session_links"),
      leases: await read("select workspace_id, status from sandbox_leases"),
    })
  })

  return app
}

let composed: Hono | undefined

export default {
  async fetch(request: Request, env: Env) {
    composed ??= compose(env.CONTROL_PLANE_DB)
    return composed.fetch(request)
  },
}
