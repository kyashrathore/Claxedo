import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxTarget } from "@claxedo/sandbox-manager"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import type { ControlPlaneServices } from "../authority/services"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import { orgSandboxDrivers } from "../sandbox/org-sandbox-drivers"
import { createOrgSandboxManager } from "../sandbox/org-sandbox-manager"
import { createD1SandboxLeaseStore } from "../sandbox/stores/d1"
import { d1OrgSandboxDriver } from "../sandbox/stores/d1-org-driver"
import { d1Authority } from "../test-support/d1-authority"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let fixture: Awaited<ReturnType<typeof d1Authority>>
let people: Record<"owner" | "member", SignedControlPlaneAuth>
let orgId: string

beforeAll(async () => {
  fixture = await d1Authority()
  people = { owner: await fixture.signIn("owner"), member: await fixture.signIn("member") }
  orgId = (await fixture.authority.usersMe(people.owner) as { org_id: string }).org_id
  await fixture.addMember(people.owner, people.member, orgId)
})
afterAll(async () => {
  await fixture.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async (request) => {
    const name = request.headers.get("authorization")?.replace(/^Bearer /, "") as keyof typeof people
    return people[name].principal!
  },
}

type Account = { live: SandboxTarget[]; failDestroy?: string }

function providerAccount(id: SandboxDriver["id"], name: string, accounts: Map<string, Account>): SandboxDriver {
  const account: Account = { live: [] }
  accounts.set(name, account)
  return {
    id,
    ensureHost: async (input) => {
      const target = { workspaceId: input.workspaceId, sandboxId: `${name}-${input.workspaceId}`, url: "https://runtime.test", hostId: `host-${input.workspaceId}`, labels: input.labels }
      account.live.push(target)
      return target
    },
    list: async () => [...account.live],
    destroy: async (target) => {
      if (account.failDestroy) throw new Error(account.failDestroy)
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

function plane() {
  const accounts = new Map<string, Account>()
  const released: string[] = []
  const leaseStore = createD1SandboxLeaseStore({ database: fixture.database })
  const sandboxes = createOrgSandboxManager({
    leaseStore,
    drivers: orgSandboxDrivers({
      operator: providerAccount("cloudflare", "operator", accounts),
      keys: {
        drivers: ["cloudflare", "boat"],
        create: (id, fields) => providerAccount(id, `org-${id}-${Object.values(fields).join("+")}`, accounts),
        chosenDriver: d1OrgSandboxDriver(fixture.database).chosen,
      },
      credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    }),
    workspaceOrg: async () => orgId,
    manager: (driver) => createSandboxManager({ leaseStore, driver, onEgressUnenforced: () => {} }),
  })
  const services = {
    authority: fixture.authority,
    sandbox: { sandboxManager: sandboxes.manager },
    telemetry: { capture: () => {} },
  } as unknown as ControlPlaneServices
  const app = HostedWorkspaceRoutes(services, {
    authentication,
    authConfig,
    releaseRuntime: async ({ workspaceId }) => void released.push(workspaceId),
  })
  const remove = (workspaceId: string, who: keyof typeof people = "owner") =>
    app.fetch(new Request(`http://cp.test/${workspaceId}`, { method: "DELETE", headers: { authorization: `Bearer ${who}` } }))
  const provisioned = async (workspaceId: string) => {
    await fixture.authority.createCloudWorkspace(people.owner, { workspaceId, displayName: workspaceId, repoUrl: "https://github.com/acme/widgets" })
    expect(await sandboxes.manager.ensure(workspaceId, { homeRegion: "us-east", labels: {} })).toMatchObject({ status: "ready" })
  }
  const listed = async () => (await fixture.authority.listWorkspaces(people.owner) as Array<{ workspace_id: string }>).map((row) => row.workspace_id)
  const live = (account: string) => (accounts.get(account)?.live ?? []).map((target) => target.workspaceId)
  return { accounts, released, remove, provisioned, listed, live, leaseStore, manager: sandboxes.manager }
}

describe("DELETE /api/workspace/:id on the hosted control plane", () => {
  test("the owner's delete destroys the sandbox on the operator's account, withdraws its runtime, deletes the row, and a repeat is answered as done", async () => {
    const { released, remove, provisioned, listed, live, leaseStore, manager } = plane()
    await provisioned("ws_operator")
    expect(live("operator")).toEqual(["ws_operator"])

    const first = await remove("ws_operator")
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ deleted: true })
    expect(live("operator")).toEqual([])
    expect((await leaseStore.get("ws_operator"))?.status).toBe("retired")
    expect(await manager.ensure("ws_operator", { homeRegion: "us-east", labels: {} })).toMatchObject({ status: "unavailable", error: "runtime_lease_retired" })
    expect(live("operator")).toEqual([])
    expect(released).toEqual(["ws_operator"])
    expect(await listed()).not.toContain("ws_operator")
    await expect(fixture.authority.openWorkspace(people.owner, { workspaceId: "ws_operator" })).rejects.toMatchObject({ status: 403 })

    const again = await remove("ws_operator")
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deleted: true })
    expect(released).toEqual(["ws_operator"])
  })

  test("a workspace on its organization's own key is destroyed through that key's provider account", async () => {
    const { remove, provisioned, live, leaseStore, manager } = plane()
    const store = hostedOrgCredentials(orgId, { database: fixture.database, env })
    const boat = await store.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-delete" }) })
    try {
      await provisioned("ws_org_key")
      expect(live("org-boat-bx-delete")).toEqual(["ws_org_key"])

      expect((await remove("ws_org_key")).status).toBe(200)
      expect(live("org-boat-bx-delete")).toEqual([])
      expect(live("operator")).toEqual([])
      expect((await leaseStore.get("ws_org_key"))?.status).toBe("retired")
      expect(await manager.ensure("ws_org_key", { homeRegion: "us-east", labels: {} })).toMatchObject({ status: "unavailable", error: "runtime_lease_retired" })
      expect(live("org-boat-bx-delete")).toEqual([])
    } finally {
      await store.deleteCredential(boat.id)
    }
  })

  test("another member of the organization is refused and nothing is destroyed", async () => {
    const { released, remove, provisioned, listed, live } = plane()
    await provisioned("ws_not_theirs")

    const refused = await remove("ws_not_theirs", "member")
    expect(refused.status).toBe(403)
    expect(live("operator")).toEqual(["ws_not_theirs"])
    expect(released).toEqual([])
    expect(await listed()).toContain("ws_not_theirs")
  })

  test("a provider that fails to destroy leaves the workspace listed with its sandbox, and the owner's next delete finishes it", async () => {
    const { accounts, released, remove, provisioned, listed, live } = plane()
    await provisioned("ws_flaky")
    accounts.get("operator")!.failDestroy = "provider unavailable"

    const failed = await remove("ws_flaky")
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: { code: "workspace_sandbox_destroy_failed", reason: "provider unavailable" } })
    expect(live("operator")).toEqual(["ws_flaky"])
    expect(released).toEqual([])
    expect(await listed()).toContain("ws_flaky")

    accounts.get("operator")!.failDestroy = undefined
    expect((await remove("ws_flaky")).status).toBe(200)
    expect(live("operator")).toEqual([])
    expect(await listed()).not.toContain("ws_flaky")
  })

  test("a workspace whose sandbox was never provisioned is deleted", async () => {
    const { remove, listed, leaseStore, manager, live } = plane()
    await fixture.authority.createCloudWorkspace(people.owner, { workspaceId: "ws_never", displayName: "never", repoUrl: "https://github.com/acme/widgets" })

    expect((await remove("ws_never")).status).toBe(200)
    expect(await listed()).not.toContain("ws_never")
    expect((await leaseStore.get("ws_never"))?.status).toBe("retired")
    expect(await manager.ensure("ws_never", { homeRegion: "us-east", labels: {} })).toMatchObject({ status: "unavailable", error: "runtime_lease_retired" })
    expect(live("operator")).toEqual([])
  })
})
