import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput, type SandboxManagerInput } from "@claxedo/sandbox-manager"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { hostedSandboxKeyDrivers } from "../authority/adapters/worker/hosted-sandbox-driver"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { d1Authority } from "../test-support/d1-authority"
import { orgSandboxDrivers } from "./org-sandbox-drivers"
import { createOrgSandboxManager, SANDBOX_KEY_LABEL, SANDBOX_ORG_LABEL } from "./org-sandbox-manager"
import { createD1SandboxLeaseStore } from "./stores/d1"
import { d1OrgSandboxDriver } from "./stores/d1-org-driver"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64") }

type Provisioned = { account: string; workspaceId: string; labels: Record<string, string> }

function providerAccount(id: string, account: string, provisioned: Provisioned[], stopped: string[]): SandboxDriver {
  return {
    id,
    ensureHost: async (input: SandboxDriverEnsureInput) => {
      provisioned.push({ account, workspaceId: input.workspaceId, labels: input.labels })
      return { sandboxId: `${account}-${input.workspaceId}`, url: "https://runtime.test", hostId: `host-${input.workspaceId}`, labels: input.labels }
    },
    stop: async (target) => void stopped.push(`${account}:${target.workspaceId}`),
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

let fixture: Awaited<ReturnType<typeof d1Authority>>
let owner: SignedControlPlaneAuth
let orgId: string
beforeAll(async () => {
  fixture = await d1Authority()
  owner = await fixture.signIn("sandbox-owner")
  orgId = (await fixture.authority.usersMe(owner) as { org_id: string }).org_id
})
afterAll(async () => {
  await fixture.dispose()
})

function rig() {
  const provisioned: Provisioned[] = []
  const stopped: string[] = []
  const built: Array<{ id: SandboxDriverID; fields: Record<string, string> }> = []
  const leaseStore = createD1SandboxLeaseStore({ database: fixture.database })
  let at = Date.now()
  const credentials = (org: string) => hostedOrgCredentials(org, { database: fixture.database, env }, { now: () => ++at })
  const sandboxes = createOrgSandboxManager({
    leaseStore,
    drivers: orgSandboxDrivers({
      operator: providerAccount("cloudflare", "operator", provisioned, stopped),
      keys: {
        drivers: ["cloudflare", "boat"],
        create: (id, fields) => {
          built.push({ id, fields })
          return providerAccount(id, `org-${id}-${Object.values(fields).join("+")}`, provisioned, stopped)
        },
        chosenDriver: d1OrgSandboxDriver(fixture.database).chosen,
      },
      credentials,
    }),
    workspaceOrg: async () => orgId,
    manager: (driver) => createSandboxManager({ leaseStore, driver, onEgressUnenforced: () => {} }),
  })
  return { ...sandboxes, provisioned, stopped, built, store: credentials(orgId) }
}

const input: SandboxManagerInput = { homeRegion: "us-east", labels: { projectId: "prj_1" } }

describe("organization sandbox keys on a hosted deployment", () => {
  test("the operator's driver serves an organization without keys; once the organization adds one, its new workspaces run on that key and older ones stay where they were made", async () => {
    const { manager, workspaceDriver, provisioned, stopped, built, store } = rig()
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
    expect((await workspaceDriver("ws_after")).metadata.secretBrokering).toBe("none")
    expect((await workspaceDriver("ws_before")).metadata.secretBrokering).toBe("native")

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
    const { manager, provisioned, store } = rig()
    await store.putCredential({ owner: null, provider_id: "cloudflare", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_token: "cf-org", worker_url: "https://sandbox.example.test" }) })
    await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-chosen" }) })
    await manager.ensure("ws_first", input)
    expect(provisioned.at(-1)?.account).toBe("org-cloudflare-cf-org+https://sandbox.example.test")

    expect(await d1OrgSandboxDriver(fixture.database).choose(owner.principal!.userId, orgId, "boat")).toBe(true)
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
})
