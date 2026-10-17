import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { UserAgentConfig } from "@claxedo/server-core/agent-config/config"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { hostedAgentConfigRoutes } from "../agent-config/hosted-routes"
import type { ControlPlaneServices } from "../authority/services"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { hostedOrgAdministers } from "../credentials/worker/org-administers"
import { UNDELIVERED_CREDENTIAL_CHANGE } from "../credentials/worker/org-routed"
import { hostedCredentialRoutes } from "../credentials/worker/routes"
import { d1Authority } from "../test-support/d1-authority"
import { RuntimeSessionAuthorityRoutes } from "./runtime-session-authority"

/**
 * A member who learns the id of an organization row (a team model key, a
 * sandbox provider key) tries to read its raw secret into their own sandbox
 * through a custom connection's secret reference.
 */

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }
const WORKSPACE = "ws-member"

let fixture: Awaited<ReturnType<typeof d1Authority>>
let people: Record<"owner" | "member", SignedControlPlaneAuth>
let orgId: string
let memberId: string
const ids: Record<"team" | "sandboxKey" | "own" | "ownAccount", string> = { team: "", sandboxKey: "", own: "", ownAccount: "" }
const configs = new Map<string, UserAgentConfig>()
let relayKeys: CryptoKeyPair

beforeAll(async () => {
  fixture = await d1Authority()
  people = { owner: await fixture.signIn("owner"), member: await fixture.signIn("member") }
  orgId = (await fixture.authority.usersMe(people.owner) as { org_id: string }).org_id
  await fixture.addMember(people.owner, people.member, orgId)
  memberId = people.member.principal!.userId
  const store = hostedOrgCredentials(orgId, { database: fixture.database, env })
  ids.team = (await store.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team-secret" })).id
  ids.sandboxKey = (await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-org-secret" }) })).id
  ids.own = (await store.putCredential({ owner: memberId, provider_id: "member-acp-token", kind: "api_key", source: "managed", secret: "member-acp-secret" })).id
  ids.ownAccount = (await store.putCredential({ owner: memberId, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-member-account" })).id
  relayKeys = await generateKeyPair("EdDSA", { extractable: true })
})
afterAll(async () => {
  await fixture.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async (request) => people[request.headers.get("authorization")?.replace(/^Bearer /, "") as keyof typeof people].principal!,
}
const repository = {
  read: async (userId: string): Promise<UserAgentConfig> => configs.get(userId) ?? { version: 3, connections: {} } as UserAgentConfig,
  write: async (userId: string, config: UserAgentConfig) => void configs.set(userId, config),
}
const credentials = (org: string) => hostedOrgCredentials(org, { database: fixture.database, env })

const settings = () => hostedAgentConfigRoutes({
  services: { authority: fixture.authority, auth: { config: authConfig } } as unknown as ControlPlaneServices,
  authentication,
  repository,
  changed: async () => {},
  credentials,
})
const accounts = () => hostedCredentialRoutes({
  authentication, authConfig, resolveOrgId: async () => orgId, credentials, change: UNDELIVERED_CREDENTIAL_CHANGE,
  administers: hostedOrgAdministers(fixture.database), keys: envelopeKeyProviderFromEnv(env),
})
const runtime = async () => RuntimeSessionAuthorityRoutes({
  authority: { runtimeAccessTokenActive: async () => ({ active: true }) } as never,
  env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKeys.publicKey) },
  connectionSecrets: {
    resolveWorkspaceOwner: async () => ({ userId: memberId, actorId: "actor-member", orgId, projectId: "project-1" }),
    readConnections: async (userId) => (await repository.read(userId)).connections,
    credentials,
  },
})

const connection = (connectionId: string, reference: string) => ({
  connectionId,
  providerKey: "acp",
  configRevision: 1,
  enabled: true,
  secretRefs: { token: reference },
  config: {
    label: "Exfiltrate",
    connection: { kind: "streamable-http", url: "https://agent.example.test" },
    modelSelection: { status: "optional" },
    secretBindings: { headers: { "x-stolen": "token" } },
  },
})

const save = (connectionId: string, reference: string) => settings().request(`https://cp.test/connections/${connectionId}`, {
  method: "PUT",
  headers: { authorization: "Bearer member", "content-type": "application/json" },
  body: JSON.stringify(connection(connectionId, reference)),
})

const lease = async (connectionId: string) => {
  const proof = await mintRelayHostToken({ principalKind: "user", actorId: "actor-member", actorKind: "human", orgId,
    workspaceId: WORKSPACE, hostId: "host-1", role: "owner", backing: "cloud-vm", jti: `proof-${connectionId}`, parentJti: "parent-1" }, relayKeys.privateKey, "EdDSA")
  return (await runtime()).request(`/connection-secrets/${WORKSPACE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
    body: JSON.stringify({ connectionId, providerKey: "acp", configRevision: 1, ownerUserId: memberId }),
  })
}

describe("a member reaching an organization row's secret through a connection", () => {
  test("the member can read the organization account's id, but saving it as a connection secret is refused, as is a sandbox key's, another person's or their own model account", async () => {
    const listed = await (await accounts().request("https://cp.test/api/claxedo/credentials/account-sources", { headers: { authorization: "Bearer member" } })).json() as { org: Array<{ id: string }> }
    expect(listed.org.map((row) => row.id)).toEqual([ids.team])

    for (const reference of [ids.team, ids.sandboxKey, ids.ownAccount, "no-such-credential"]) {
      const refused = await save(`steal-${reference.slice(0, 6)}`, reference)
      expect(refused.status, reference).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "agent_config_secret_ref_refused" } })
    }
    expect(configs.get(memberId)?.connections ?? {}).toEqual({})
    expect((await save("own-acp", ids.own)).status).toBe(200)
  })

  test("a connection already holding such a reference leases nothing from it, while the member's own key still leases", async () => {
    const saved = configs.get(memberId) ?? { version: 3, connections: {} } as UserAgentConfig
    configs.set(memberId, {
      ...saved,
      connections: {
        ...saved.connections,
        "steal-team": connection("steal-team", ids.team),
        "steal-sandbox": connection("steal-sandbox", ids.sandboxKey),
        "steal-account": connection("steal-account", ids.ownAccount),
      },
    } as UserAgentConfig)
    for (const connectionId of ["steal-team", "steal-sandbox", "steal-account"]) {
      const answer = await lease(connectionId)
      expect(answer.status, connectionId).toBe(409)
      expect(JSON.stringify(await answer.json())).not.toMatch(/secret|bx-org|sk-/)
    }
    const own = await lease("own-acp")
    expect(own.status).toBe(200)
    expect((await own.json()).secrets).toEqual({ token: "member-acp-secret" })
  })

  test("a member of two organizations saves a key from either, and a workspace of the other organization leases nothing from it", async () => {
    configs.delete(memberId)
    const orgs = await fixture.authority.listOrgs(people.member) as Array<{ org_id: string }>
    const personal = orgs.map((row) => row.org_id).find((id) => id !== orgId)!
    const elsewhere = await hostedOrgCredentials(personal, { database: fixture.database, env })
      .putCredential({ owner: memberId, provider_id: "member-acp-token", kind: "api_key", source: "managed", secret: "member-personal-org-secret" })
    const saved = await save("personal-acp", elsewhere.id)
    expect(await saved.json()).toMatchObject({ ok: true })
    expect((await lease("personal-acp")).status).toBe(409)
  })
})
