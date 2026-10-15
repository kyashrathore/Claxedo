import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  createSandboxManager,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxManagerInput,
  type SandboxTarget,
} from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore, sandboxLease } from "@claxedo/sandbox-manager/stores/memory"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { sandboxStartPhaseSink } from "./sandbox-telemetry"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { d1Authority } from "../test-support/d1-authority"
import { orgSandboxDrivers, SandboxProviderKeyMissingError } from "./org-sandbox-drivers"
import { createOrgSandboxManager, liftOrgKeyRetryWaits, SANDBOX_KEY_LABEL, SANDBOX_ORG_LABEL } from "./org-sandbox-manager"
import { createD1SandboxLeaseStore } from "./stores/d1"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64") }

type Provisioned = { account: string; workspaceId: string; labels: Record<string, string> }
type Fixture = Awaited<ReturnType<typeof d1Authority>>

function providerAccount(id: string, account: string, provisioned: Provisioned[], stopped: string[], live: Map<string, SandboxTarget[]>): SandboxDriver {
  const running = live.get(account) ?? []
  live.set(account, running)
  return {
    id,
    ensureHost: async (input: SandboxDriverEnsureInput) => {
      provisioned.push({ account, workspaceId: input.workspaceId, labels: input.labels })
      const target = { workspaceId: input.workspaceId, sandboxId: `${account}-${input.workspaceId}`, url: "https://runtime.test", hostId: `host-${input.workspaceId}`, labels: input.labels }
      running.push(target)
      return target
    },
    stop: async (target) => void stopped.push(`${account}:${target.workspaceId}`),
    list: async () => [...running],
    destroy: async (target) => void running.splice(running.findIndex((entry) => entry.sandboxId === target.sandboxId), 1),
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: id === "cloudflare" ? "native" : "none",
      egressControl: "hosts",
      persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
    },
  }
}

async function signedInOrg(fixture: Fixture) {
  const owner = await fixture.signIn("sandbox-owner")
  return { owner, orgId: (await fixture.authority.usersMe(owner) as { org_id: string }).org_id }
}

function rig(fixture: Fixture, orgId: string, options: { builds?: boolean } = {}) {
  const provisioned: Provisioned[] = []
  const stopped: string[] = []
  const built: Array<{ id: SandboxDriverID; fields: Record<string, string> }> = []
  const live = new Map<string, SandboxTarget[]>()
  const captured: Array<Record<string, unknown> | undefined> = []
  const onStartPhase = sandboxStartPhaseSink({ capture: (_id, _event, properties) => void captured.push(properties) })
  const leaseStore = createD1SandboxLeaseStore({ database: fixture.database })
  let at = Date.now()
  const credentials = (org: string) => hostedOrgCredentials(org, { database: fixture.database, env }, { now: () => ++at })
  const sandboxes = createOrgSandboxManager({
    leaseStore,
    drivers: orgSandboxDrivers({
      keys: {
        drivers: ["cloudflare", "boat"],
        create: (id, fields) => {
          built.push({ id, fields })
          return options.builds === false ? undefined : providerAccount(id, `org-${id}-${Object.values(fields).join("+")}`, provisioned, stopped, live)
        },
        chosenDriver: d1OrgSandboxDriver(fixture.database).chosen,
      },
      credentials,
    }),
    workspaceOrg: async () => orgId,
    manager: (driver) => createSandboxManager({ leaseStore, driver, onEgressUnenforced: () => {}, onStartPhase }),
  })
  const orphan = (account: string, workspaceId: string) =>
    live.get(account)?.push({ sandboxId: `${account}-${workspaceId}`, url: "https://runtime.test", hostId: `host-${workspaceId}`, labels: { app: "claxedo", workspaceId, epoch: "1" } })
  return { ...sandboxes, provisioned, stopped, built, captured, leaseStore, orphan, store: credentials(orgId) }
}

let fixture: Fixture
let owner: SignedControlPlaneAuth
let orgId: string
beforeAll(async () => {
  fixture = await d1Authority()
  ;({ owner, orgId } = await signedInOrg(fixture))
})
afterAll(async () => {
  await fixture.dispose()
})

const input: SandboxManagerInput = { homeRegion: "us-east", labels: { projectId: "prj_1" } }

describe("organization sandbox keys on a hosted deployment", () => {
  test("an organization without a key starts nothing; once it adds one, its new workspaces run on that key and older ones stay where they were made", async () => {
    const { manager, workspaceDriver, orgDriver, provisioned, stopped, built, store } = rig(fixture, orgId)
    const choice = d1OrgSandboxDriver(fixture.database)
    await expect(manager.ensure("ws_before", input)).rejects.toBeInstanceOf(SandboxProviderKeyMissingError)
    await expect(orgDriver(orgId)).rejects.toMatchObject({ code: "sandbox_provider_key_missing", status: 409 })
    expect(await manager.target("ws_before")).toEqual({ status: "unavailable", reason: "runtime_lease_missing" })
    expect(await manager.destroy("ws_before")).toEqual({ ok: false, reason: "runtime_lease_missing" })
    expect(await manager.release("ws_before")).toEqual({ released: false })
    expect(provisioned).toEqual([])

    const boat = await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-org" }) })
    const cloudflare = await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test" }) })
    try {
      expect(await manager.ensure("ws_boat", input)).toMatchObject({ status: "ready" })
      expect(provisioned.at(-1)).toEqual({
        account: "org-boat-bx-org",
        workspaceId: "ws_boat",
        labels: expect.objectContaining({ [SANDBOX_KEY_LABEL]: boat.id, [SANDBOX_ORG_LABEL]: orgId }),
      })
      expect(built).toEqual([{ id: "boat", fields: { api_key: "bx-org" } }])
      expect(await workspaceDriver("ws_boat")).toMatchObject({ id: "boat", metadata: { secretBrokering: "none" } })

      expect(await choice.choose(owner.principal!.userId, orgId, "cloudflare")).toBe(true)
      expect(await manager.ensure("ws_cloudflare", input)).toMatchObject({ status: "ready" })
      expect(provisioned.at(-1)).toMatchObject({ account: "org-cloudflare-cf-org+https://sandbox.example.test", workspaceId: "ws_cloudflare" })
      expect(await workspaceDriver("ws_boat")).toMatchObject({ id: "boat" })
      expect(await workspaceDriver("ws_cloudflare")).toMatchObject({ id: "cloudflare", metadata: { secretBrokering: "native" } })

      await manager.stop("ws_boat")
      await manager.stop("ws_cloudflare")
      expect(stopped).toEqual(["org-boat-bx-org:ws_boat", "org-cloudflare-cf-org+https://sandbox.example.test:ws_cloudflare"])
      expect(built).toHaveLength(2)

      await store.deleteCredential(boat.id)
      await expect(manager.destroy("ws_boat")).rejects.toThrow("has been removed")
      expect(await manager.ensure("ws_later", input)).toMatchObject({ status: "ready" })
      expect(provisioned.at(-1)).toMatchObject({ account: "org-cloudflare-cf-org+https://sandbox.example.test", workspaceId: "ws_later" })
    } finally {
      await choice.choose(owner.principal!.userId, orgId, undefined)
      await store.deleteCredential(cloudflare.id)
    }
  })

  test("how a workspace's driver brokers secrets is read from the catalog, so a key that cannot build its driver still answers, and nothing brokers without a key", async () => {
    const { workspaceDriver, workspaceSecretBrokering, store } = rig(fixture, orgId, { builds: false })
    expect(await workspaceSecretBrokering("ws_keyless")).toBe("none")
    const cloudflare = await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test" }) })
    try {
      expect(await workspaceSecretBrokering("ws_keyed")).toBe("native")
      await expect(workspaceDriver("ws_keyed")).rejects.toThrow("cannot build a driver")
    } finally {
      await store.deleteCredential(cloudflare.id)
    }
  })

  test("with several keys, new workspaces use the organization's chosen driver", async () => {
    const { manager, orgDriver, provisioned, store } = rig(fixture, orgId)
    await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test" }) })
    await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-chosen" }) })
    await manager.ensure("ws_first", input)
    expect(provisioned.at(-1)?.account).toBe("org-cloudflare-cf-org+https://sandbox.example.test")

    expect(await d1OrgSandboxDriver(fixture.database).choose(owner.principal!.userId, orgId, "boat")).toBe(true)
    expect(await orgDriver(orgId)).toMatchObject({ id: "boat" })
    await manager.ensure("ws_chosen", input)
    expect(provisioned.at(-1)?.account).toBe("org-boat-bx-chosen")
  })

  test("an organization key's start phases land on its lease and its telemetry under that key's driver, never naming the key", async () => {
    const { manager, leaseStore, captured, store } = rig(fixture, orgId)
    await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-phases" }) })
    expect(await d1OrgSandboxDriver(fixture.database).choose(owner.principal!.userId, orgId, "boat")).toBe(true)
    const ready = await manager.ensure("ws_phases", input)
    if (ready.status !== "ready") throw new Error(`ensure answered ${ready.status}`)
    captured.length = 0

    await manager.recordStartPhases("ws_phases", { epoch: ready.epoch, phases: [{ phase: "repository_checkout", durationMs: 40 }] })
    await manager.markStartPhase("ws_phases", { epoch: ready.epoch, phase: "first_session_ready", notBefore: Date.now() })

    const lease = await leaseStore.get("ws_phases")
    const key = lease?.labels?.[SANDBOX_KEY_LABEL]
    expect(lease?.driver).toBe("boat")
    expect(key).toBeDefined()
    expect(lease?.start?.phases).toEqual(expect.arrayContaining(["repository_checkout", "first_session_ready"]))
    expect(captured).toEqual([
      expect.objectContaining({ phase: "repository_checkout", workspace_id: "ws_phases", driver: "boat", org_id: orgId }),
      expect.objectContaining({ phase: "first_session_ready", workspace_id: "ws_phases", driver: "boat", org_id: orgId }),
    ])
    expect(JSON.stringify(captured)).not.toContain(key)
  })
})

describe("sweeping orphaned sandboxes across keys", () => {
  let swept: Fixture
  let sweptOwner: SignedControlPlaneAuth
  let sweptOrg: string
  beforeAll(async () => {
    swept = await d1Authority()
    ;({ owner: sweptOwner, orgId: sweptOrg } = await signedInOrg(swept))
  })
  afterAll(async () => {
    await swept.dispose()
  })

  test("a sweep collects orphans on every organization key a lease names, keeps what leases own, visits no account nothing runs on, and names a key it can no longer open", async () => {
    const { manager, orphan, store } = rig(swept, sweptOrg)
    const cloudflareAccount = "org-cloudflare-cf-gc+https://sandbox.example.test"
    expect((await manager.garbageCollect())).toEqual({ destroyed: [], kept: [], skipped: [], failed: [] })

    await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-gc", worker_url: "https://sandbox.example.test" }) })
    await manager.ensure("ws_cloudflare", input)
    const boat = await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-gc" }) })
    expect(await d1OrgSandboxDriver(swept.database).choose(sweptOwner.principal!.userId, sweptOrg, "boat")).toBe(true)
    await manager.ensure("ws_org", input)
    orphan(cloudflareAccount, "ws_gone_cloudflare")
    orphan("org-boat-bx-gc", "ws_gone_org")

    const first = await manager.garbageCollect()
    expect(first.destroyed.map((target) => target.sandboxId).sort()).toEqual(["org-boat-bx-gc-ws_gone_org", `${cloudflareAccount}-ws_gone_cloudflare`])
    expect(first.kept.map((target) => target.sandboxId).sort()).toEqual(["org-boat-bx-gc-ws_org", `${cloudflareAccount}-ws_cloudflare`])
    expect(first.unreachable).toBeUndefined()
    expect((await manager.list()).map((lease) => lease.workspaceId).sort()).toEqual(["ws_cloudflare", "ws_org"])

    expect((await manager.garbageCollect()).destroyed).toEqual([])

    await store.deleteCredential(boat.id)
    const blind = await manager.garbageCollect()
    expect(blind.kept.map((target) => target.sandboxId)).toEqual([`${cloudflareAccount}-ws_cloudflare`])
    expect(blind.unreachable).toEqual([{ driver: "boat", error: "The sandbox provider key this workspace was created with has been removed" }])
  })
})

describe("a change to an organization's sandbox key", () => {
  test("lifts the retry wait of every start on that key or with no machine yet, and of no other organization's or key's", async () => {
    const waiting = (workspaceId: string, org: string, key: string, sandboxId?: string) => sandboxLease({
      workspaceId,
      status: "unavailable",
      retryCount: 5,
      nextRetryAt: Date.now() + 600_000,
      lastError: "Boat refused the sandbox provider key",
      labels: { [SANDBOX_KEY_LABEL]: key, [SANDBOX_ORG_LABEL]: org },
      ...(sandboxId ? { sandboxId, hostId: `host-${workspaceId}` } : {}),
    })
    const store = createMemoryLeaseStore([
      waiting("ws_on_key", "org_a", "key_boat", "bx_on_key"),
      waiting("ws_no_machine", "org_a", "key_cloudflare"),
      waiting("ws_other_key", "org_a", "key_cloudflare", "cf_other_key"),
      waiting("ws_other_org", "org_b", "key_boat", "bx_other_org"),
    ])

    await liftOrgKeyRetryWaits(store, "org_a", "key_boat")

    const retry = async (workspaceId: string) => {
      const lease = await store.get(workspaceId)
      return { retryCount: lease?.retryCount, nextRetryAt: lease?.nextRetryAt }
    }
    expect(await retry("ws_on_key")).toEqual({ retryCount: 0, nextRetryAt: undefined })
    expect(await retry("ws_no_machine")).toEqual({ retryCount: 0, nextRetryAt: undefined })
    expect(await retry("ws_other_key")).toMatchObject({ retryCount: 5, nextRetryAt: expect.any(Number) })
    expect(await retry("ws_other_org")).toMatchObject({ retryCount: 5, nextRetryAt: expect.any(Number) })
  })
})
