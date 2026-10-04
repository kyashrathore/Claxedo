import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  createSandboxManager,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxManagerInput,
  type SandboxTarget,
} from "@claxedo/sandbox-manager"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { hostedSandboxKeyDrivers } from "../authority/adapters/worker/hosted-sandbox-driver"
import { sandboxStartPhaseSink } from "../authority/provider-neutral-hosted-services"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { d1Authority } from "../test-support/d1-authority"
import { orgSandboxDrivers } from "./org-sandbox-drivers"
import { createOrgSandboxManager, SANDBOX_KEY_LABEL, SANDBOX_ORG_LABEL } from "./org-sandbox-manager"
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
      secretBrokering: account === "operator" ? "native" : "none",
      egressControl: "hosts",
      persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
    },
  }
}

async function signedInOrg(fixture: Fixture) {
  const owner = await fixture.signIn("sandbox-owner")
  return { owner, orgId: (await fixture.authority.usersMe(owner) as { org_id: string }).org_id }
}

function rig(fixture: Fixture, orgId: string) {
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
      operator: providerAccount("cloudflare", "operator", provisioned, stopped, live),
      keys: {
        drivers: ["cloudflare", "boat"],
        create: (id, fields) => {
          built.push({ id, fields })
          return providerAccount(id, `org-${id}-${Object.values(fields).join("+")}`, provisioned, stopped, live)
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
  test("the operator's driver serves an organization without keys; once the organization adds one, its new workspaces run on that key and older ones stay where they were made", async () => {
    const { manager, workspaceDriver, provisioned, stopped, built, store } = rig(fixture, orgId)
    expect(await manager.ensure("ws_before", input)).toMatchObject({ status: "ready" })
    expect(provisioned.at(-1)).toMatchObject({ account: "operator", labels: { [SANDBOX_KEY_LABEL]: "operator", projectId: "prj_1" } })

    const boat = await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-org" }) })
    expect(await manager.ensure("ws_after", input)).toMatchObject({ status: "ready" })
    expect(provisioned.at(-1)).toEqual({
      account: "org-boat-bx-org",
      workspaceId: "ws_after",
      labels: expect.objectContaining({ [SANDBOX_KEY_LABEL]: boat.id, [SANDBOX_ORG_LABEL]: orgId }),
    })
    expect(built).toEqual([{ id: "boat", fields: { api_key: "bx-org" } }])
    expect(await workspaceDriver("ws_after")).toMatchObject({ key: "org", driver: { id: "boat", metadata: { secretBrokering: "none" } } })
    expect(await workspaceDriver("ws_before")).toMatchObject({ key: "operator", driver: { id: "cloudflare", metadata: { secretBrokering: "native" } } })

    await manager.stop("ws_before")
    await manager.stop("ws_after")
    expect(stopped).toEqual(["operator:ws_before", "org-boat-bx-org:ws_after"])
    expect(built).toHaveLength(1)

    await store.deleteCredential(boat.id)
    await expect(manager.destroy("ws_after")).rejects.toThrow("has been removed")
    expect(await manager.ensure("ws_later", input)).toMatchObject({ status: "ready" })
    expect(provisioned.at(-1)).toMatchObject({ account: "operator", workspaceId: "ws_later" })
  })

  test("with several keys, new workspaces use the organization's chosen driver", async () => {
    const { manager, orgDriver, provisioned, store } = rig(fixture, orgId)
    await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test" }) })
    await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-chosen" }) })
    await manager.ensure("ws_first", input)
    expect(provisioned.at(-1)?.account).toBe("org-cloudflare-cf-org+https://sandbox.example.test")

    expect(await d1OrgSandboxDriver(fixture.database).choose(owner.principal!.userId, orgId, "boat")).toBe(true)
    expect(await orgDriver(orgId)).toMatchObject({ key: "org", driver: { id: "boat" } })
    await manager.ensure("ws_chosen", input)
    expect(provisioned.at(-1)?.account).toBe("org-boat-bx-chosen")
  })

  test("a Worker deployment builds organization drivers only for the catalog's Worker drivers, with its own runtime image", () => {
    const keys = hostedSandboxKeyDrivers({ CLAXEDO_SANDBOX_IMAGE: "ghcr.io/claxedo/runtime:test" })
    expect(keys.drivers).toEqual(["cloudflare", "boat"])
    expect(keys.create("boat", { api_key: "bx" })?.id).toBe("boat")
    expect(keys.create("cloudflare", { api_token: "cf", worker_url: "https://sandbox.example.test" })?.id).toBe("cloudflare")
    expect(keys.create("vercel", { access_token: "t", team_id: "t", project_id: "p" })).toBeUndefined()
    expect(hostedSandboxKeyDrivers({}).create("boat", { api_key: "bx" })).toBeUndefined()
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
    expect(key).not.toBe("operator")
    expect(lease?.start?.phases).toEqual(expect.arrayContaining(["repository_checkout", "first_session_ready"]))
    expect(captured).toEqual([
      expect.objectContaining({ phase: "repository_checkout", workspace_id: "ws_phases", driver: "boat", key_owner: "org" }),
      expect.objectContaining({ phase: "first_session_ready", workspace_id: "ws_phases", driver: "boat", key_owner: "org" }),
    ])
    expect(JSON.stringify(captured)).not.toContain(key)
  })
})

describe("sweeping orphaned sandboxes across keys", () => {
  let swept: Fixture
  let sweptOrg: string
  beforeAll(async () => {
    swept = await d1Authority()
    sweptOrg = (await signedInOrg(swept)).orgId
  })
  afterAll(async () => {
    await swept.dispose()
  })

  test("a sweep collects orphans on the operator's account and on an organization key a lease names, keeps what leases own, and names a key it can no longer open", async () => {
    const { manager, orphan, store } = rig(swept, sweptOrg)
    await manager.ensure("ws_operator", input)
    const boat = await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-gc" }) })
    await manager.ensure("ws_org", input)
    orphan("operator", "ws_gone_operator")
    orphan("org-boat-bx-gc", "ws_gone_org")

    const first = await manager.garbageCollect()
    expect(first.destroyed.map((target) => target.sandboxId).sort()).toEqual(["operator-ws_gone_operator", "org-boat-bx-gc-ws_gone_org"])
    expect(first.kept.map((target) => target.sandboxId).sort()).toEqual(["operator-ws_operator", "org-boat-bx-gc-ws_org"])
    expect(first.unreachable).toBeUndefined()
    expect((await manager.list()).map((lease) => lease.workspaceId).sort()).toEqual(["ws_operator", "ws_org"])

    expect((await manager.garbageCollect()).destroyed).toEqual([])

    await store.deleteCredential(boat.id)
    const blind = await manager.garbageCollect()
    expect(blind.kept.map((target) => target.sandboxId)).toEqual(["operator-ws_operator"])
    expect(blind.unreachable).toEqual([{ driver: "boat", error: "The sandbox provider key this workspace was created with has been removed" }])
  })
})
