import { afterEach, expect, test } from "vitest"
import { UNDELIVERED_CREDENTIAL_CHANGE } from "../../credentials/worker/org-routed"
import { countD1Rounds, type D1Rounds } from "../../test-support/d1-rounds"
import { hostedCoreD1App } from "../../test-support/hosted-core-d1-app"
import { hostedOrgAdministers } from "../../credentials/worker/org-administers"
import { hostedSandboxDriverKeys } from "../../sandbox/hosted-sandbox-driver-keys"
import { createD1SandboxLeaseStore } from "../../sandbox/stores/d1"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const READY = { status: "ready" as const, hostId: "host_1", epoch: 1, sandboxId: "sb_1", url: "https://sandbox.test", homeRegion: "us-east" }

async function signedReader(workspace = true) {
  let counted: D1Rounds | undefined
  const app = await hostedCoreD1App(disposers, {
    database: (database) => {
      counted = countD1Rounds(database)
      return counted.database
    },
    services: {
      relay: { relayUrl: "https://relay.test", runtimeAccessTokenSigner: async () => ({ runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: `jti_${Date.now()}` }) },
      sandbox: { sandboxManager: { target: async () => READY } },
    } as never,
    routes: ({ database }) => ({
      productWorkspace: { sandboxStart: async () => READY },
      accountSetup: {
        change: UNDELIVERED_CREDENTIAL_CHANGE,
        administers: hostedOrgAdministers(database),
        sandboxDriverKeys: hostedSandboxDriverKeys({ database, drivers: ["boat"], hostedBroker: true, leaseStore: createD1SandboxLeaseStore({ database }) }),
      },
    }),
  })
  const alice = await app.person("alice")
  let orgId = ""
  if (workspace) {
    orgId = ((await app.call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await app.authority.createWorkspace(alice.auth, { workspaceId: "ws_acme", orgId, displayName: "acme", backing: "cloud-vm", repoUrl: "https://github.com/acme/app" })
  }
  const rounds = async (method: string, path: string, body?: unknown) => {
    counted!.reset()
    const response = await app.call(alice.token, method, path, body)
    expect(response.status, `${method} ${path} ${JSON.stringify(response.body)}`).toBe(200)
    return { rounds: counted!.rounds(), statements: counted!.statements() }
  }
  const traced = async (method: string, path: string, body?: unknown) => {
    const measured = await rounds(method, path, body)
    return { ...measured, trace: counted!.trace().map((entry) => `${entry.round}: ${entry.sql}`) }
  }
  return { app, alice, orgId, rounds, traced }
}

/**
 * Every read the onboarding wizard makes pays one Worker-to-database hop per
 * serial D1 round, after the auth-database rounds that verified the cookie.
 * The principal row is the one round every signed route shares, and each
 * catalog read runs beside it keyed by the principal the auth names: the
 * workspace list with each machine row's `host_online` in the same statement,
 * the shared sessions from the caller's share grants, the rail's first pages
 * (the projects the caller may open, then one batch of pages) and the
 * caller's machines.
 */
test("the catalog reads the first run makes answer in one serial control-plane round beside the principal", async () => {
  const { rounds } = await signedReader()
  const measured = {
    workspaces: await rounds("GET", "/api/workspace?host=provisioner"),
    sharedSessions: await rounds("GET", "/api/workspace/shared-sessions"),
    sessionPages: await rounds("GET", "/api/control/session-list?scope=projects"),
    devices: await rounds("GET", "/api/claxedo/remote-access/devices"),
  }
  expect(measured).toEqual({
    workspaces: { rounds: 1, statements: 2 },
    sharedSessions: { rounds: 1, statements: 2 },
    sessionPages: { rounds: 2, statements: 3 },
    devices: { rounds: 1, statements: 2 },
  })
})

/**
 * Every connection answers from the principal row, the caller's organizations
 * and the workspace it may open read together, then the token's record and
 * its audit as one batch: a connect to a live sandbox and a read off one pay
 * two serial control-plane rounds (the sandbox lease is the sandbox manager's,
 * not this store's). A read off a serving machine pays two more between them,
 * since `activeWorkspaceHost` proves the caller's access again before it
 * reads the assignment.
 */
test("a connect to a live sandbox pays two control-plane rounds", async () => {
  const { rounds } = await signedReader()
  expect(await rounds("POST", "/api/workspace/ws_acme/connection", {})).toEqual({ rounds: 2, statements: 7 })
})

test("a workspace connection read off a live sandbox pays two control-plane rounds", async () => {
  const { rounds } = await signedReader()
  expect(await rounds("GET", "/api/workspace/ws_acme/connection")).toEqual({ rounds: 2, statements: 7 })
})

test("a workspace connection read off a serving machine pays four control-plane rounds", async () => {
  const { app, alice, orgId, rounds } = await signedReader()
  await app.authority.createWorkspace(alice.auth, { workspaceId: "ws_laptop", orgId, displayName: "laptop", backing: "local-worktree" })
  const who = { userId: alice.auth.principal.userId, actorId: alice.auth.principal.actorId }
  const now = Date.now()
  const database = app.controlPlane.database
  await database.prepare(`insert into host_enrollments (enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json, last_seen_at, expires_at, created_at, updated_at, session_authority, serving_generation) values ('enr_1', ?, ?, 'host_laptop', '{}', ?, ?, ?, ?, 'local', 1)`).bind(who.userId, who.actorId, now, now + 600_000, now, now).run()
  await database.prepare(`insert into host_workspace_assignments (workspace_id, host_id, org_id, owner_user_id, owner_actor_id, assigned_at, updated_at, revision) values ('ws_laptop', 'host_laptop', ?, ?, ?, ?, ?, 1)`).bind(orgId, who.userId, who.actorId, now, now).run()
  await database.prepare(`insert into host_assignment_readiness (workspace_id, enrollment_id, generation, revision, ready_at) values ('ws_laptop', 'enr_1', 1, 1, ?)`).bind(now).run()
  expect(await rounds("GET", "/api/workspace/ws_laptop/connection")).toEqual({ rounds: 4, statements: 9 })
})

/**
 * Settings → Models reads the person's accounts, the ones in use and their
 * account sources at once, and the Add dialog reads the sign-in methods, so the
 * deepest of those chains is the time the page waits. Every one pays one round
 * for the principal row and the caller's organizations together, then one for
 * its own reads together: the list beside the organization's sandbox driver
 * that decides each row's reach, the selections beside the accounts in use,
 * and the selections, the organization's rows and whether the caller manages
 * them. The sign-in methods are a table in the Worker and read nothing.
 */
test("the account reads Settings → Models makes answer in few serial control-plane rounds", async () => {
  const { app, alice, traced } = await signedReader(false)
  const saved = await app.call(alice.token, "PUT", "/api/claxedo/credentials", { provider_id: "claude-sdk", kind: "oauth_token", source: "managed", label: "plan", secret: "sk-ant-oat01-rounds" })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  const measured = {
    accounts: await traced("GET", "/api/claxedo/credentials"),
    effective: await traced("GET", "/api/claxedo/credentials/effective"),
    sources: await traced("GET", "/api/claxedo/credentials/account-sources"),
    signInMethods: await traced("GET", "/api/claxedo/agent-config/providers/auth?nativeHarness=claude"),
  }
  expect(Object.fromEntries(Object.entries(measured).map(([route, { rounds, statements }]) => [route, { rounds, statements }]))).toEqual({
    accounts: { rounds: 2, statements: 4 },
    effective: { rounds: 2, statements: 4 },
    sources: { rounds: 2, statements: 6 },
    signInMethods: { rounds: 0, statements: 0 },
  })
})

/**
 * Adding the organization's sandbox provider key, as the Where step does: the
 * save pays the principal round, the manage check, the row's lookup, its write,
 * then the leases whose failed starts the new key may fix. The listing reads the rows, the manage check and the chosen driver
 * together; choosing the default reads the manage check beside the rows, writes
 * the choice, then lists.
 */
test("a sandbox provider key's save, listing and default choice pay few serial control-plane rounds", async () => {
  const { traced } = await signedReader(false)
  const save = await traced("PUT", "/api/claxedo/credentials", { provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "boat-key" }) })
  const listing = await traced("GET", "/api/claxedo/credentials/sandbox-drivers")
  const chosen = await traced("PUT", "/api/claxedo/credentials/sandbox-drivers/default", { driver: "boat" })
  expect({ save: save.rounds, listing: listing.rounds, chosen: chosen.rounds }, JSON.stringify({ save: save.trace, chosen: chosen.trace }, null, 1)).toEqual({ save: 5, listing: 2, chosen: 4 })
})
