import {
  atlassianIntegration,
  createConnectionsService,
  createIntegrationRegistry,
  createIntegrationsRoutes,
  linearIntegration,
  type ConnectionRow,
  type ConnectionStorePort,
  type CredentialStorePort,
  type IntegrationCapability,
  type IntegrationDeclaration,
  type IntegrationImpl,
} from "@claxedo/connections"
import { Hono, type Context } from "hono"
import { anyApi, type FunctionReference } from "convex/server"
import { controlPlaneAuthContext, type ClerkVerifier, type ControlPlaneAuthConfig } from "../../../platform/auth/auth"
import { hostedOrgCredentials } from "../../../adapters/credentials/worker/index"
import { githubIntegrationForEnv } from "../../../connections/github-oauth"
import type { ControlPlaneCredentials } from "../../../authority/services"

type Executor = Readonly<{
  query(fn: unknown, args: Record<string, unknown>): Promise<unknown>
  mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>
}>

type Query = FunctionReference<"query">
type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as {
  orgs: { membershipByClerkIds: Query }
  workgraphConnections: { listMetadata: Query; upsertMetadata: Mutation; deleteMetadata: Mutation }
}

type Metadata = Readonly<{
  id: string
  integrationId: "github" | "linear" | "jira"
  capabilities: string[]
  status: "connected" | "degraded" | "broken"
  accountLabel?: string
  fields?: Record<string, string>
  tokenType?: "bearer" | "basic"
}>

/** Worker-safe Connections setup backed by Convex metadata and encrypted per-org credentials. */
export function createHostedConnectionsSetup(input: Readonly<{
  env: Record<string, string | undefined>
  authConfig: ControlPlaneAuthConfig
  executor: Executor
  serviceToken: string
  verifier?: ClerkVerifier
  integrations?: ReadonlyArray<{ decl: IntegrationDeclaration; impl: IntegrationImpl }>
  credentials?: (orgId: string) => ControlPlaneCredentials
  requireEntitlement?: (clerkOrgId: string) => Promise<{
    status: 402 | 503
    body: { error: { code: string; message: string } }
  } | undefined>
}>) {
  const app = new Hono()
  const handle = async (c: Context) => {
    const auth = await controlPlaneAuthContext(c.req.raw, {
      config: input.authConfig,
      ...(input.verifier ? { verifier: input.verifier } : {}),
      cliTokenEnv: input.env,
    })
    if (auth.mode !== "signed" || !auth.user.orgId) return c.json({ code: "connections_org_required" }, 403)
    const denied = await input.requireEntitlement?.(auth.user.orgId)
    if (denied) return c.json(denied.body, denied.status)
    const membership = await input.executor.query(api.orgs.membershipByClerkIds, {
      service_token: input.serviceToken,
      clerk_org_id: auth.user.orgId,
      clerk_subject: auth.user.subject,
    }) as { member?: boolean; org_id?: string; user_id?: string } | null
    if (!membership?.member || !membership.org_id || !membership.user_id) {
      return c.json({ code: "connections_org_membership_required" }, 403)
    }
    const service = hostedConnectionsService(input, membership.user_id, membership.org_id)
    const routes = createIntegrationsRoutes(service, {
      teamOwner: () => `org:${membership.org_id}`,
      ownerlessRows: "refuse",
    })
    const url = new URL(c.req.url)
    url.pathname = c.req.path.replace(/^\/api\/claxedo\/integrations/, "") || "/"
    return routes.fetch(new Request(url, c.req.raw))
  }
  app.all("/", handle)
  app.all("/*", handle)
  return app
}

function hostedConnectionsService(
  input: Parameters<typeof createHostedConnectionsSetup>[0],
  ownerUserId: string,
  orgId: string,
) {
  const registry = createIntegrationRegistry()
  for (const integration of input.integrations ?? [githubIntegrationForEnv(input.env), linearIntegration(), atlassianIntegration()]) {
    registry.register(integration.decl, integration.impl)
  }
  return createConnectionsService({
    registry,
    credentials: credentialStore(input.credentials?.(orgId) ?? hostedOrgCredentials(orgId, input.env)),
    connections: connectionStore(input.executor, input.serviceToken, ownerUserId, orgId),
    newId: () => crypto.randomUUID(),
  })
}

function connectionStore(executor: Executor, serviceToken: string, ownerUserId: string, orgId: string): ConnectionStorePort {
  const list = async () => (await executor.query(api.workgraphConnections.listMetadata, {
    service_token: serviceToken,
    ownerUserId,
    orgId,
  }) as Metadata[]).map((row) => fromMetadata(row, orgId))
  return {
    async upsert(row) {
      await executor.mutation(api.workgraphConnections.upsertMetadata, {
        service_token: serviceToken,
        ownerUserId,
        orgId,
        connectionId: row.id,
        integrationId: row.integrationId === "atlassian" ? "jira" : row.integrationId,
        capabilities: row.grantedCapabilities,
        status: "connected",
        ...(row.accountLabel ? { accountLabel: row.accountLabel } : {}),
        ...(Object.keys(row.fields).length ? { fields: row.fields } : {}),
        tokenType: row.integrationId === "atlassian" ? "basic" : "bearer",
      })
    },
    async get(integrationId, owner) {
      if (owner !== `org:${orgId}`) return undefined
      return (await list()).find((row) => row.integrationId === integrationId)
    },
    async getById(id) {
      return (await list()).find((row) => row.id === id)
    },
    async list(filter) {
      if (filter?.owner === null) return []
      if (filter?.owner !== undefined && filter.owner !== `org:${orgId}`) return []
      return list()
    },
    async delete(id) {
      const result = await executor.mutation(api.workgraphConnections.deleteMetadata, {
        service_token: serviceToken,
        ownerUserId,
        orgId,
        connectionId: id,
      }) as { deleted?: boolean }
      return result.deleted === true
    },
  }
}

function fromMetadata(row: Metadata, orgId: string): ConnectionRow {
  const now = Date.now()
  return {
    id: row.id,
    integrationId: row.integrationId === "jira" ? "atlassian" : row.integrationId,
    owner: `org:${orgId}`,
    ...(row.accountLabel ? { accountLabel: row.accountLabel } : {}),
    grantedCapabilities: row.capabilities as IntegrationCapability[],
    fields: row.fields ?? {},
    createdAt: now,
    updatedAt: now,
  }
}

function credentialStore(credentials: ReturnType<typeof hostedOrgCredentials>): CredentialStorePort {
  const resolveSecret = credentials.resolveCredentialSecret
  if (!resolveSecret) throw new Error("Hosted Connections requires credential secret resolution")
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
    async readSecret(providerId) {
      const value = await credentials.getCredentialByProvider(providerId)
      if (!value) return null
      if (value.status !== "available") await credentials.updateCredentialStatus(value.id, "available")
      return resolveSecret(providerId)
    },
    async setStatus(providerId, status, lastError) {
      const value = await credentials.getCredentialByProvider(providerId)
      if (value) await credentials.updateCredentialStatus(value.id, status, lastError)
    },
    deleteByProvider: async (providerId) => { await credentials.deleteCredentialsByProvider(providerId) },
  }
}
