import { expect, vi } from "vitest"
import type { Hono } from "hono"
import {
  AuthenticationError,
  type AuthIdentity,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { createHostedCoreApp } from "../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../authority/hosted-services"
import type { ControlPlaneServices } from "../authority/services"
import { composeBetterAuthD1Authority } from "../authority/adapters/worker/better-auth-d1-compose"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { betterAuthAccount } from "../platform/auth/better-auth-d1-authentication-evidence"
import { orgInvitationEmailDelivery } from "../platform/auth/auth-email-delivery"
import { testRequestAuthenticationAdapter } from "./request-authentication"
import { miniflareControlPlaneDatabase } from "./control-plane-migrations"


const AUTH_MIGRATIONS = fileURLToPath(new URL("../../migrations/auth/", import.meta.url))
const CREDENTIAL_ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }

/** Better Auth's own database, where the only copy of an account's email lives. */
async function authDatabase(disposers: Array<() => Promise<void>>) {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB"],
  })
  disposers.push(() => instance.dispose())
  const database = await instance.getD1Database("AUTH_DB")
  for (const name of readdirSync(AUTH_MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = (await readFile(`${AUTH_MIGRATIONS}${name}`, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  return database
}

/**
 * The hosted core app over a real D1 control plane and its encrypted
 * credential store. The bearer token names a
 * person whose identity the D1 authority minted, so every role a route decides
 * on is the one the database holds.
 */
export async function hostedCoreD1App(
  disposers: Array<() => Promise<void>>,
  options: {
    database?: (database: D1Database) => D1Database
    /** Service ports a test supplies over the plane's bare ones, such as a sandbox manager and a token signer. */
    services?: Partial<Pick<ControlPlaneServices, "relay" | "sandbox">>
    routes?: Partial<Pick<Parameters<typeof createHostedCoreApp>[1], "productWorkspace">>
  } = {},
) {
  const migrated = await miniflareControlPlaneDatabase()
  const controlPlane = { ...migrated, database: options.database?.(migrated.database) ?? migrated.database }
  disposers.push(() => controlPlane.dispose())
  const accounts = await authDatabase(disposers)
  const sent: Array<{ recipient: string; token: string }> = []
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: controlPlane.database,
    },
    product: { kind: "claxedo-hosted" },
    invitations: orgInvitationEmailDelivery({ verifiedEmail: async (auth) => (await betterAuthAccount({ database: accounts, issuer: "https://auth.test" }, auth.principal?.identity))?.verifiedEmail, appOrigin: "https://app.test", sender: { send: async (message) => { sent.push(message) } } }),
  })
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database: controlPlane.database, env: CREDENTIAL_ENV })
  const principals = new Map<string, ControlPlanePrincipal>()
  const authentication: RequestAuthenticationAdapter = {
    descriptor: testRequestAuthenticationAdapter().descriptor,
    async authenticate(request) {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const principal = token ? principals.get(token) : undefined
      if (!principal) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      return principal
    },
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" } },
    relay: options.services?.relay ?? {},
    sandbox: options.services?.sandbox ?? {},
    authority,
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  const plane = {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 60,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 1_000,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    privateSessionAuthority: authority,
    runtimeSessionAuthority: authority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
    orgCredentials: credentials,
  } as unknown as HostedControlPlane
  const app = createHostedCoreApp(plane, {
    authentication,
    liveSyncRoom: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
    cloudWorkspaceAdmission: async () => undefined,
    product: STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"],
    requestGuardExemptions: [],
    ...options.routes,
  } as unknown as Parameters<typeof createHostedCoreApp>[1]) as unknown as Hono

  const person = async (subject: string) => {
    await accounts.prepare(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, 1, 1, 1) on conflict (id) do nothing`)
      .bind(subject, subject, `${subject}@example.test`).run()
    const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.test", subject }
    const mapped = await authority.ensureApplicationIdentity(identity)
    if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
    principals.set(subject, {
      userId: mapped.userId,
      actorId: mapped.actorId,
      actorKind: "human",
      deploymentId: "deployment-a",
      sessionId: `session:${subject}`,
      authenticatedAt: 1_800_000_000_000,
      methods: ["oauth:google"],
      assurance: "single-factor",
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read"],
        deploymentId: "deployment-a",
        adapter: "better-auth",
        issuer: "https://auth.test",
        tokenEndpointOrigin: "https://auth.test",
        controlPlaneOrigin: "https://core.test",
      },
      identity,
    })
    return { token: subject, userId: mapped.userId, auth: await signedAuth(subject) }
  }
  const signedAuth = async (subject: string) => {
    const principal = principals.get(subject)!
    return {
      mode: "signed" as const,
      principal,
      user: { subject: principal.userId, tokenIdentifier: `https://auth.test|${subject}`, issuer: "https://auth.test" },
    }
  }
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(`https://core.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as never }
  }
  const account = async (subject: string, email: string, verified: boolean) => {
    await accounts
      .prepare(`insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt") values (?, ?, ?, ?, null, 1, 1)`)
      .bind(subject, subject, email, verified ? 1 : 0)
      .run()
    return await person(subject)
  }
  const join = async (adminToken: string, orgId: string, member: { token: string }) => {
    expect(await call(adminToken, "POST", `/api/control/orgs/${orgId}/invitations`, { email: `${member.token}@example.test`, role: "member" })).toEqual({ status: 202, body: { message: "invitation sent" } })
    return call(member.token, "POST", "/api/control/invitations/accept", { token: sent.at(-1)!.token })
  }
  return { authority, controlPlane, credentials, person, account, call, join, sent }
}

