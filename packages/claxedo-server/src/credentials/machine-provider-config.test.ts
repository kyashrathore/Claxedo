import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { D1Database } from "@cloudflare/workers-types"
import { machineSealAad } from "@claxedo/account-contract/machine"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { parseHostProviderConfig } from "@claxedo/server-core/credentials/host-provider-config"
import type { MachinePrincipal, MachineProviderConfigBuild, MachineProviderConfigState } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { openSeal } from "../test-support/machine-seal"
import { HOSTED_CREDENTIALS_FLAG, hostedBrokerCredentialReader, hostedOrgCredentials } from "./worker/index"
import { createHostedEgressBroker, PLACEHOLDER_TTL_SECONDS, verifyBrokerPlaceholder } from "./hosted-egress-broker"
import { createMachineProviderConfig, providerConfigBuildDue, type MachineProviderConfigStore } from "./machine-provider-config"

const CREDENTIAL_ENV = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }
const NOW = 1_800_000_000_000

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const MACHINE: MachinePrincipal = {
  enrollmentId: "enrollment_1", hostId: "host_vps", ownerUserId: "alice", ownerActorId: "actor_alice",
  scope: { allowed_roots: ["/srv"], revision: 1 }, keyVersion: 1, generation: 2,
}

describe("when a connected machine's beat builds", () => {
  const state: MachineProviderConfigState = {
    enrollmentId: "enrollment_1", hostId: "host_vps", ownerUserId: "alice", orgId: "org-1", servingGeneration: 2,
    sealingPublicKey: "{}", nextRevision: 4, ownerPushPending: false, rekeyed: false,
    built: { generation: 2, renewAt: NOW + 1_000, accounts: "a" },
  }

  test("only when it holds no current build, a new instance serves, its stand-ins are half spent or what it holds no longer opens", () => {
    expect(providerConfigBuildDue(state, NOW)).toBe(false)
    expect(providerConfigBuildDue({ ...state, built: undefined }, NOW)).toBe(true)
    expect(providerConfigBuildDue({ ...state, servingGeneration: 3 }, NOW)).toBe(true)
    expect(providerConfigBuildDue(state, NOW + 1_000)).toBe(true)
    expect(providerConfigBuildDue({ ...state, rekeyed: true }, NOW)).toBe(true)
    expect(providerConfigBuildDue({ ...state, built: { ...state.built!, renewAt: null } }, NOW + 10 ** 9)).toBe(false)
  })

  test("never over an owner's push it has not acked, nor before it declared a key or serves", () => {
    expect(providerConfigBuildDue({ ...state, built: undefined, ownerPushPending: true }, NOW)).toBe(false)
    expect(providerConfigBuildDue({ ...state, built: undefined, sealingPublicKey: null }, NOW)).toBe(false)
    expect(providerConfigBuildDue({ ...state, built: undefined, servingGeneration: 0 }, NOW)).toBe(false)
  })
})

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

/** The stored enrollment as the D1 authority answers it, kept in memory. */
function memoryStore(initial: MachineProviderConfigState) {
  let state: MachineProviderConfigState | undefined = initial
  const stored: MachineProviderConfigBuild[] = []
  const stale: string[] = []
  let refuse = false
  const reads = vi.fn(async () => state)
  const store: MachineProviderConfigStore = {
    machineProviderConfigState: reads,
    storeMachineProviderConfig: vi.fn(async (_machine, build) => {
      if (refuse) return false
      stored.push(build)
      state = state && { ...state, nextRevision: build.revision + 1, built: { generation: build.generation, renewAt: build.renewAt, accounts: build.accounts } }
      return true
    }),
    providerConfigMachines: vi.fn(async () => state ? [{ enrollmentId: state.enrollmentId, ownerUserId: state.ownerUserId, hostId: state.hostId, accounts: state.built?.accounts ?? null }] : []),
    staleMachineProviderConfigAccounts: vi.fn(async (ids) => {
      stale.push(...ids)
      if (state?.built && ids.includes(state.enrollmentId)) state = { ...state, built: undefined }
    }),
  }
  return { store, reads, stored, stale, set: (next: MachineProviderConfigState | undefined) => { state = next }, refuse: () => { refuse = true } }
}

async function rig() {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const database = instance.database as unknown as D1Database
  const credentials = (orgId: string) => hostedOrgCredentials(orgId, { database, env: CREDENTIAL_ENV })
  const signing = await signingEnv()
  const broker = createHostedEgressBroker({
    credentials,
    read: (orgId) => hostedBrokerCredentialReader(orgId, { database, env: CREDENTIAL_ENV }),
    workspaceOwner: async () => undefined,
    sandboxManager: { target: async () => ({ status: "unavailable", reason: "runtime_lease_missing" }) },
    env: signing,
    origin: "https://core.test",
    now: () => NOW,
  })
  const sealing = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const publicJwk = await crypto.subtle.exportKey("jwk", sealing.publicKey)
  const sealingPublicKey = JSON.stringify({ kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y })
  const memory = memoryStore({
    enrollmentId: MACHINE.enrollmentId, hostId: MACHINE.hostId, ownerUserId: "alice", orgId: "org-1", servingGeneration: 2,
    sealingPublicKey, nextRevision: 4, ownerPushPending: false, rekeyed: false,
  })
  let clock = NOW
  const configs = createMachineProviderConfig({ store: memory.store, credentials, broker, now: () => clock })
  const open = async (revision: number, sealed: string) =>
    parseHostProviderConfig(await openSeal(sealing.privateKey, sealed, machineSealAad({ enrollmentId: MACHINE.enrollmentId, revision })))
  return { configs, memory, store: credentials("org-1"), signing, open, advance: (ms: number) => { clock += ms } }
}

describe("a connected machine's provider configuration, built on its beat", () => {
  test("binds every account the owner spends, the ChatGPT plan included, to a stand-in naming the machine's enrollment, with no secret in it", async () => {
    const { configs, memory, store, signing, open } = await rig()
    await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-alice" })
    const plan = await store.putCredential({
      owner: "alice", provider_id: "codex-app-server", kind: "oauth_token", source: "managed",
      secret: JSON.stringify({ tokens: { access_token: "chatgpt-real-access", account_id: "acct_plan" } }),
    })
    await store.putCredential({ owner: "alice", provider_id: "cursor-sdk", kind: "api_key", source: "managed", secret: "key_user_cursor" })
    await store.putCredential({ owner: "bob", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-bob" })

    const delivered = await configs.beat(MACHINE)
    expect(delivered?.revision).toBe(4)
    expect(delivered!.sealed).not.toContain("sk-ant-api03-alice")
    const config = await open(4, delivered!.sealed)
    expect(config.source).toBe("control-plane")
    expect(config.credentials.direct).toBeUndefined()
    const rows = config.credentials.accounts.alice
    expect(Object.keys(rows).sort()).toEqual(["anthropic", "codex-app-server", "cursor-sdk"])
    expect(rows["cursor-sdk"]).toEqual({ unavailable: true, reason: "harness_needs_brokering" })
    expect(rows["codex-app-server"]).toMatchObject({ authMode: "bearer", apiPath: "/backend-api/codex", account: { credentialId: plan.id } })
    const opened = JSON.stringify(rows)
    for (const secret of ["sk-ant-api03-alice", "chatgpt-real-access", "key_user_cursor", "sk-bob"]) expect(opened).not.toContain(secret)
    const anthropic = rows.anthropic as { placeholder: string; baseUrl: string; expiresAt: number }
    expect(anthropic.baseUrl).toMatch(/^https:\/\/core\.test\/bindings\/[0-9a-f]{32}$/)
    expect(anthropic.expiresAt).toBe(NOW + PLACEHOLDER_TTL_SECONDS * 1_000)
    expect(await verifyBrokerPlaceholder(anthropic.placeholder, signing, { now: () => NOW })).toMatchObject({
      userId: "alice", orgId: "org-1", enrollmentId: MACHINE.enrollmentId, leaseId: `host:${MACHINE.enrollmentId}`, leaseGeneration: 2, runtimeId: MACHINE.hostId,
    })

    expect(memory.stored).toEqual([expect.objectContaining({
      revision: 4, generation: 2, providerIds: ["anthropic", "codex-app-server", "cursor-sdk"],
      renewAt: NOW + (PLACEHOLDER_TTL_SECONDS * 1_000) / 2, accounts: expect.any(String),
    })])
  })

  test("builds once, then again only when it is due: at half the stand-ins' life, or on a new serving generation", async () => {
    const { configs, memory, store, advance } = await rig()
    await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-alice" })
    expect(await configs.beat(MACHINE)).toMatchObject({ revision: 4 })
    expect(await configs.beat(MACHINE)).toBeUndefined()
    advance((PLACEHOLDER_TTL_SECONDS * 1_000) / 2)
    expect(await configs.beat(MACHINE)).toMatchObject({ revision: 5 })
    const current = await memory.store.machineProviderConfigState(MACHINE)
    memory.set({ ...current!, servingGeneration: 3 })
    expect(await configs.beat({ ...MACHINE, generation: 3 })).toMatchObject({ revision: 6 })
    expect(memory.stored.map((build) => build.generation)).toEqual([2, 2, 3])
  })

  test("answers nothing for a machine with no build state or when the store refused the write, and a failed build waits a minute before its next try", async () => {
    const { configs, memory, store, advance } = await rig()
    await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-alice" })
    memory.refuse()
    expect(await configs.beat(MACHINE)).toBeUndefined()
    const current = await memory.store.machineProviderConfigState(MACHINE)
    memory.set({ ...current!, sealingPublicKey: "not a key" })
    expect(await configs.beat(MACHINE)).toBeUndefined()
    expect(memory.reads).toHaveBeenCalledTimes(3)
    expect(await configs.beat(MACHINE)).toBeUndefined()
    expect(memory.reads).toHaveBeenCalledTimes(3)
    advance(60_000)
    memory.set(undefined)
    expect(await configs.beat(MACHINE)).toBeUndefined()
    expect(memory.reads).toHaveBeenCalledTimes(4)
  })

  test("a credential write that changes what the owner spends marks the machine due and rings it, after the write's own delivery; one that changes nothing rings nobody", async () => {
    const { configs, memory, store } = await rig()
    await store.putCredential({ owner: "alice", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-alice" })
    await configs.beat(MACHINE)
    const order: string[] = []
    const ring = vi.fn(async () => { order.push("ring") })
    const change = configs.credentialChange(async () => async () => { order.push("sandboxes") }, ring)

    await (await change("org-1"))()
    expect(ring).not.toHaveBeenCalled()
    expect(memory.stale).toEqual([])

    await store.putCredential({ owner: "alice", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-alice-openai" })
    await (await change("org-1"))()
    expect(ring).toHaveBeenCalledWith({ ownerUserId: "alice", hostId: MACHINE.hostId })
    expect(order).toEqual(["sandboxes", "sandboxes", "ring"])
    expect(memory.stale).toEqual([MACHINE.enrollmentId])
    expect(await configs.beat(MACHINE)).toMatchObject({ revision: 5 })
  })
})
