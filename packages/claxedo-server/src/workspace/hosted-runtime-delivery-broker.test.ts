import { afterEach, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { accountPlaceholderEnv } from "@claxedo/server-core/credentials/native-delivery-plan"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedSandboxRedeliver, unusedSandboxStart, unusedWorkspaceIdleStop } from "../test-support/inline-sandbox-start"
import { hostedBrokerCredentialReader, hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "../credentials/worker"
import { createHostedEgressBroker, DRAFT_PLACEHOLDER, verifyBrokerPlaceholder } from "../credentials/hosted-egress-broker"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"

const followed = vi.fn(async (_context: { workspaceId: string }, _due: { renewAt?: number; watchAt?: number }) => {})

const configApplied = vi.hoisted(() => vi.fn(async (_snapshot: import("@claxedo/workspace-runtime/config").RuntimeSnapshot) => {}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({
  applyConfig: configApplied,
  configStatus: async () => ({ state: "applied", revision: 1 }),
})) }))
// The placeholder pass is minted with the real runtime key; only the supervisor token, whose runtime is mocked away, is stubbed.
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claxedo/server-core/platform/auth/runtime-access-token")>()),
  mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })),
}))

/**
 * What a cloud workspace's sandbox is delivered for one stored Anthropic key,
 * by the driver its organization chose: Boat, which has no provider edge, and
 * Cloudflare, which has one.
 */

const ORIGIN = "https://api.claxedo.test"
const CREDENTIAL_ENV = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64") }

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

async function composition(driver: "boat" | "cloudflare", options: { broker?: false } = {}) {
  const instance = await workspaceBackingDatabase([{ id: "ws-a", backing: "cloud-vm" }])
  active.push(instance)
  const database = instance.database as unknown as D1Database
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database, env: CREDENTIAL_ENV })
  const signing = await signingEnv()
  const sandboxManager = { target: async () => ({ status: "ready" as const, hostId: "host-a", sandboxId: "sb-a", url: "https://runtime.test", epoch: 3, homeRegion: "us-east" }) }
  const broker = options.broker === false ? undefined : createHostedEgressBroker({
    credentials,
    read: (orgId) => hostedBrokerCredentialReader(orgId, { database, env: CREDENTIAL_ENV }),
    workspaceOwner: async () => ({ userId: "owner", actorId: "actor-owner", orgId: "org", projectId: "project" }),
    sandboxManager,
    env: signing,
    origin: ORIGIN,
  })
  type Input = Parameters<typeof createHostedRuntimeDelivery>[0]
  const delivery = createHostedRuntimeDelivery({
    sandboxRefresh: unusedSandboxStart,
    sandboxRedeliver: unusedSandboxRedeliver,
    sandboxFollow: followed,
    idleStop: unusedWorkspaceIdleStop,
    authority: { resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org", projectId: "project" }) } as unknown as Input["authority"],
    database,
    services: { sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host-a", url: "https://runtime.test", epoch: 3 }) } } } as unknown as Input["services"],
    sandboxManager: {
      target: async () => ({ status: "ready", hostId: "host-a", url: "https://runtime.test", epoch: 3 }),
      heartbeat: async () => ({ ok: true, status: "ready" }),
    } as unknown as Input["sandboxManager"],
    workspaceSecretBrokering: async () => driver === "cloudflare" ? "native" : "none",
    ...(broker ? { broker } : {}),
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
    credentials: () => credentials("org"), signingEnv: signing, provisionedRunner: undefined,
  })
  const store = credentials("org")
  const key = await store.putCredential({ owner: "owner", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner-key", label: "Work key" })
  const pushed = async () => {
    configApplied.mockClear()
    const preparation = await delivery.prepareRuntime({ workspaceId: "ws-a" })
    await delivery.provisionRuntime({ workspaceId: "ws-a" }, preparation)
    const snapshot = configApplied.mock.calls.at(-1)![0]
    return { secrets: preparation.secrets ?? [], snapshot, row: snapshot.auth.accounts.owner?.anthropic }
  }
  return { delivery, store, key, signing, pushed }
}

test("a Boat sandbox is handed a binding on the plane's broker and no edge secret; its placeholder names the sandbox and the account", async () => {
  const { delivery, key, signing, pushed } = await composition("boat")
  const before = Date.now()
  const { secrets, snapshot, row } = await pushed()

  expect(secrets).toEqual([])
  if (!row || isProviderUnavailable(row)) throw new Error(`the account was not delivered: ${JSON.stringify(row)}`)
  expect(row).toMatchObject({
    baseUrl: expect.stringMatching(new RegExp(`^${ORIGIN}/bindings/[0-9a-f]{32}$`)),
    authMode: "api-key",
    apiPath: "/v1",
    account: { credentialId: key.id, providerId: "anthropic", label: "Work key" },
  })
  expect(row.placeholderEnv).toBeUndefined()
  expect(await verifyBrokerPlaceholder(row.placeholder!, signing)).toMatchObject({
    userId: "owner", orgId: "org", workspaceId: "ws-a", leaseId: "sandbox:ws-a", leaseGeneration: 3, runtimeId: "host-a", credentialId: key.id,
  })
  expect(JSON.stringify(snapshot)).not.toContain("sk-ant-api03-owner-key")
  // Re-delivered at half of the placeholder's hour, which is when the provisioner's alarm comes back for it.
  const renewAt = await delivery.start.renew("ws-a")
  expect(renewAt).toBeGreaterThan(before + 29 * 60 * 1000)
  expect(renewAt).toBeLessThan(before + 31 * 60 * 1000)
  expect(configApplied).toHaveBeenCalledTimes(2)
})

test("an owner on the team account gets a binding for the organization's key in place of their own, and loses it when the key is removed", async () => {
  const { store, signing, pushed } = await composition("boat")
  const team = await store.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team-key", label: "Team" })
  await store.setAccountSources(["claude-sdk", "claude-acp", "anthropic"], "org", "org", "owner")
  const { snapshot, row } = await pushed()
  if (!row || isProviderUnavailable(row)) throw new Error(`the team account was not delivered: ${JSON.stringify(row)}`)
  expect(row.account).toEqual({ credentialId: team.id, providerId: "anthropic", label: "Team" })
  expect(await verifyBrokerPlaceholder(row.placeholder!, signing)).toMatchObject({ userId: "org:org", credentialId: team.id, workspaceId: "ws-a" })
  expect(snapshot.auth.accounts.owner?.["claude-sdk"]).toEqual({ unavailable: true, reason: "org_account_unavailable" })
  expect(JSON.stringify(snapshot)).not.toContain("sk-ant-api03")

  await store.deleteCredential(team.id)
  expect((await pushed()).row).toEqual({ unavailable: true, reason: "org_account_unavailable" })
})

test("an owner on the team account has a Cloudflare edge hold the organization's key, under the team account's own variable", async () => {
  const { store, pushed } = await composition("cloudflare")
  const team = await store.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team-key" })
  await store.setAccountSources(["claude-sdk", "claude-acp", "anthropic"], "org", "org", "owner")
  const { secrets, row } = await pushed()
  expect(secrets).toEqual([expect.objectContaining({ name: accountPlaceholderEnv(team), value: "sk-ant-api03-team-key", hosts: ["api.anthropic.com"] })])
  expect(row).toMatchObject({ placeholderEnv: accountPlaceholderEnv(team), baseUrl: "https://api.anthropic.com" })
})

test("a draft on a Boat workspace learns the account is deliverable without a placeholder being minted", async () => {
  const { delivery } = await composition("boat")
  const draft = await delivery.credentialSnapshot("ws-a")
  const row = draft?.accounts.owner?.anthropic
  if (!row || isProviderUnavailable(row)) throw new Error(`the draft was refused: ${JSON.stringify(row)}`)
  expect(row.placeholder).toBe(DRAFT_PLACEHOLDER)
  expect(row.expiresAt).toBeUndefined()
})

test("a Cloudflare sandbox keeps its edge: the key is the edge's secret and the runtime reads the edge's variable, with no binding on the plane", async () => {
  const { pushed, delivery } = await composition("cloudflare")
  const { secrets, row } = await pushed()
  expect(secrets).toEqual([expect.objectContaining({ value: "sk-ant-api03-owner-key", hosts: ["api.anthropic.com"], header: "x-api-key" })])
  expect(row).toMatchObject({ baseUrl: "https://api.anthropic.com", placeholderEnv: secrets[0].name, authMode: "api-key" })
  expect(JSON.stringify(row)).not.toContain("/bindings/")
  expect(await delivery.start.renew("ws-a")).toBeUndefined()
})

test("a Boat sandbox on a plane without a broker is refused the account, as before", async () => {
  const { pushed } = await composition("boat", { broker: false })
  const { secrets, row } = await pushed()
  expect(secrets).toEqual([])
  expect(row).toEqual({ unavailable: true, reason: "harness_needs_brokering" })
})

test("a Cursor key on a Boat sandbox stays refused: its exchange cannot be served from the plane", async () => {
  const { store, pushed } = await composition("boat")
  await store.putCredential({ owner: "owner", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_user_cursor" })
  const { snapshot } = await pushed()
  expect(snapshot.auth.accounts.owner?.["cursor-sdk"]).toEqual({ unavailable: true, reason: "harness_needs_brokering" })
  expect(snapshot.auth.accounts.owner?.anthropic).toMatchObject({ baseUrl: expect.stringContaining("/bindings/") })
})
