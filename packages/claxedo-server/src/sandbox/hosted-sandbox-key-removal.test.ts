import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxTarget } from "@claxedo/sandbox-manager"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import type { ControlPlaneServices } from "../authority/services"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { hostedCredentialRoutes } from "../credentials/worker/routes"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import { d1Authority } from "../test-support/d1-authority"
import { hostedSandboxDriverKeys } from "./hosted-sandbox-driver-keys"
import { orgSandboxDrivers } from "./org-sandbox-drivers"
import { createOrgSandboxManager, SANDBOX_KEY_LABEL } from "./org-sandbox-manager"
import { createD1SandboxLeaseStore } from "./stores/d1"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let fixture: Awaited<ReturnType<typeof d1Authority>>
let owner: SignedControlPlaneAuth
let orgId: string

beforeAll(async () => {
  fixture = await d1Authority()
  owner = await fixture.signIn("owner")
  orgId = (await fixture.authority.usersMe(owner) as { org_id: string }).org_id
})
afterAll(async () => {
  await fixture.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async () => owner.principal!,
}

type Account = { live: SandboxTarget[]; entered?: () => void; gate?: Promise<void> }

function providerAccount(id: SandboxDriver["id"], name: string, accounts: Map<string, Account>): SandboxDriver {
  const account: Account = accounts.get(name) ?? { live: [] }
  accounts.set(name, account)
  return {
    id,
    ensureHost: async (input) => {
      account.entered?.()
      await account.gate
      const target = { workspaceId: input.workspaceId, sandboxId: `${name}-${input.workspaceId}`, url: "https://runtime.test", hostId: `host-${input.workspaceId}`, labels: input.labels }
      account.live.push(target)
      return target
    },
    list: async () => [...account.live],
    destroy: async (target) => {
      account.live = account.live.filter((entry) => entry.sandboxId !== target.sandboxId)
    },
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "hosts",
      persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
    },
  }
}

const BOAT_ACCOUNT = "org-boat-bx-org"

function plane() {
  const accounts = new Map<string, Account>()
  const hooks: { beforeChoice?: () => Promise<void> } = {}
  const leaseStore = createD1SandboxLeaseStore({ database: fixture.database })
  const sandboxes = createOrgSandboxManager({
    leaseStore,
    drivers: orgSandboxDrivers({
      operator: providerAccount("cloudflare", "operator", accounts),
      keys: {
        drivers: ["cloudflare", "boat"],
        create: (id, fields) => providerAccount(id, `org-${id}-${Object.values(fields).join("+")}`, accounts),
        chosenDriver: async (org) => {
          const hook = hooks.beforeChoice
          hooks.beforeChoice = undefined
          await hook?.()
          return await d1OrgSandboxDriver(fixture.database).chosen(org)
        },
      },
      credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    }),
    workspaceOrg: async () => orgId,
    manager: (driver) => createSandboxManager({ leaseStore, driver, onEgressUnenforced: () => {} }),
  })
  const credentialsApp = hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => orgId,
    credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    changed: async () => {},
    keys: envelopeKeyProviderFromEnv(env),
    sandboxDriverKeys: hostedSandboxDriverKeys({ database: fixture.database, authority: fixture.authority, drivers: ["cloudflare", "boat"], managed: "cloudflare", managedMetadata: { secretBrokering: "native" } }),
  })
  const workspaceApp = HostedWorkspaceRoutes(
    { authority: fixture.authority, sandbox: { sandboxManager: sandboxes.manager }, telemetry: { capture: () => {} } } as unknown as ControlPlaneServices,
    { authentication, authConfig, releaseRuntime: async () => {} },
  )
  const credentials = (path: string, method = "GET", body?: unknown) =>
    credentialsApp.request(`https://cp.test/api/claxedo/credentials${path}`, {
      method,
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const addKey = async () => {
    const saved = await credentials("", "PUT", { provider_id: "boat", kind: "sandbox_driver", secret: JSON.stringify({ api_key: "bx-org" }) })
    return (await saved.json() as { credential: { id: string } }).credential.id
  }
  const keys = async () => (await (await credentials("/sandbox-drivers")).json() as { keys: Array<{ id: string }> }).keys.map((key) => key.id)
  const create = async (workspaceId: string) =>
    await fixture.authority.createCloudWorkspace(owner, { workspaceId, displayName: workspaceId, repoUrl: "https://github.com/acme/widgets" })
  const ensure = (workspaceId: string) => sandboxes.manager.ensure(workspaceId, { homeRegion: "us-east", labels: {} })
  const deleteWorkspace = async (workspaceId: string) =>
    (await workspaceApp.fetch(new Request(`http://cp.test/${workspaceId}`, { method: "DELETE", headers: { authorization: "Bearer owner" } }))).status
  const live = (name: string) => (accounts.get(name)?.live ?? []).map((target) => target.workspaceId)
  return { accounts, hooks, leaseStore, sandboxes, credentials, addKey, keys, create, ensure, deleteWorkspace, live }
}

describe("removing an organization's sandbox provider key", () => {
  test("a key workspaces still run on is kept and the refusal says how many; once they are deleted it is removed and nothing reaches for it again", async () => {
    const rig = plane()
    const key = await rig.addKey()
    for (const workspaceId of ["ws_kept_a", "ws_kept_b"]) {
      await rig.create(workspaceId)
      expect(await rig.ensure(workspaceId)).toMatchObject({ status: "ready" })
    }
    expect(rig.live(BOAT_ACCOUNT)).toEqual(["ws_kept_a", "ws_kept_b"])

    const refused = await rig.credentials(`/${key}`, "DELETE")
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: {
        code: "sandbox_driver_key_in_use",
        message: "2 workspaces still use this sandbox provider key. Delete them before removing the key.",
        details: { workspaces: 2 },
      },
    })
    expect(await rig.keys()).toEqual([key])

    expect(await rig.deleteWorkspace("ws_kept_a")).toBe(200)
    const stillOne = await rig.credentials(`/${key}`, "DELETE")
    expect(stillOne.status).toBe(409)
    expect((await stillOne.json() as { error: { message: string } }).error.message)
      .toBe("1 workspace still uses this sandbox provider key. Delete it before removing the key.")

    expect(await rig.deleteWorkspace("ws_kept_b")).toBe(200)
    const removed = await rig.credentials(`/${key}`, "DELETE")
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ deleted: true })
    expect(await rig.keys()).toEqual([])
    expect(await (await rig.credentials(`/${key}`, "DELETE")).json()).toEqual({ deleted: false })

    expect((await rig.sandboxes.manager.garbageCollect()).unreachable).toBeUndefined()
    await rig.create("ws_after_removal")
    expect(await rig.ensure("ws_after_removal")).toMatchObject({ status: "ready" })
    expect(rig.live("operator")).toEqual(["ws_after_removal"])
    expect(await rig.deleteWorkspace("ws_after_removal")).toBe(200)
  })

  test("a workspace whose machine is being made on the key while the removal runs is counted, and the key stays", async () => {
    const rig = plane()
    const key = await rig.addKey()
    await rig.create("ws_in_flight")
    const account: Account = { live: [] }
    let release = () => {}
    const entered = new Promise<void>((resolve) => { account.entered = resolve })
    account.gate = new Promise<void>((resolve) => { release = resolve })
    rig.accounts.set(BOAT_ACCOUNT, account)

    const starting = rig.ensure("ws_in_flight")
    await entered
    const refused = await rig.credentials(`/${key}`, "DELETE")
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { details: { workspaces: 1 } } })
    release()
    expect(await starting).toMatchObject({ status: "ready" })
    expect(rig.live(BOAT_ACCOUNT)).toEqual(["ws_in_flight"])
    expect(await rig.keys()).toEqual([key])

    expect(await rig.deleteWorkspace("ws_in_flight")).toBe(200)
    expect(await (await rig.credentials(`/${key}`, "DELETE")).json()).toEqual({ deleted: true })
  })

  test("a workspace that chose the key just before it was removed makes no machine on it, and can still be deleted", async () => {
    const rig = plane()
    const key = await rig.addKey()
    await rig.create("ws_warm")
    expect(await rig.ensure("ws_warm")).toMatchObject({ status: "ready" })
    expect(await rig.deleteWorkspace("ws_warm")).toBe(200)

    await rig.create("ws_late")
    let removal: unknown
    rig.hooks.beforeChoice = async () => {
      removal = await (await rig.credentials(`/${key}`, "DELETE")).json()
    }
    expect(await rig.ensure("ws_late")).toMatchObject({
      status: "unavailable",
      error: "The sandbox provider key this workspace was created with has been removed",
    })
    expect(removal).toEqual({ deleted: true })
    expect(rig.live(BOAT_ACCOUNT)).toEqual([])
    expect(rig.live("operator")).toEqual([])
    expect((await rig.leaseStore.get("ws_late"))?.labels?.[SANDBOX_KEY_LABEL]).toBe(key)

    expect(await rig.deleteWorkspace("ws_late")).toBe(200)
    expect(await rig.leaseStore.get("ws_late")).toBeUndefined()
  })
})
