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
    routes: ({ authority, database }) => ({
      productWorkspace: { sandboxStart: async () => READY },
      accountSetup: {
        change: UNDELIVERED_CREDENTIAL_CHANGE,
        administers: hostedOrgAdministers(database),
        sandboxDriverKeys: hostedSandboxDriverKeys({ database, authority, drivers: ["boat"], hostedBroker: true, leaseStore: createD1SandboxLeaseStore({ database }) }),
      },
    }),
  })
  const alice = await app.person("alice")
  if (workspace) {
    const orgId = ((await app.call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await app.authority.createWorkspace(alice.auth, { workspaceId: "ws_acme", orgId, displayName: "acme", backing: "cloud-vm", repoUrl: "https://github.com/acme/app" })
  }
  const rounds = async (method: string, path: string, body?: unknown) => {
    counted!.reset()
    const response = await app.call(alice.token, method, path, body)
    expect(response.status, `${method} ${path} ${JSON.stringify(response.body)}`).toBe(200)
    return { rounds: counted!.rounds(), statements: counted!.statements() }
  }
  const traced = async (method: string, path: string) => {
    const measured = await rounds(method, path)
    return { ...measured, trace: counted!.trace().map((entry) => `${entry.round}: ${entry.sql}`) }
  }
  return { app, alice, rounds, traced }
}

/**
 * Every read the onboarding wizard makes pays one cross-region hop per
 * serial D1 round on a Worker placed away from its database (staging: Worker in
 * LHR, D1 in ENAM, ~80 ms a hop). The principal row is the one round every
 * signed route shares; the route's own read follows it and nothing else does.
 */
test("the catalog reads the first run makes answer in two serial control-plane rounds", async () => {
  const { rounds } = await signedReader()
  const measured = {
    workspaces: await rounds("GET", "/api/workspace?host=provisioner"),
    sharedSessions: await rounds("GET", "/api/workspace/shared-sessions"),
  }
  expect(measured).toEqual({
    workspaces: { rounds: 2, statements: 2 },
    sharedSessions: { rounds: 2, statements: 2 },
  })
})

/**
 * A connect to a live sandbox: the principal, the workspace it may open, the
 * caller's organizations beside the provisioner call, then the token's record
 * and its audit (a guard, a batch) together. The lease is the sandbox
 * manager's, not this store's.
 */
test("a connect to a live sandbox pays four control-plane rounds", async () => {
  const { rounds } = await signedReader()
  expect(await rounds("POST", "/api/workspace/ws_acme/connection", {})).toEqual({ rounds: 4, statements: 7 })
})

/**
 * Settings → Models reads the person's accounts, the ones in use and their
 * account sources at once, and the Add dialog reads the sign-in methods, so the
 * deepest of those chains is the time the page waits. Every one pays the
 * principal row and the organization resolution first; the accounts' own reads
 * follow them one at a time (list, then the organization's sandbox driver for
 * the reach of each row), while the account sources read the selections, the
 * organization's rows and whether the caller manages them at once. The sign-in
 * methods are a table in the Worker and read nothing.
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
    accounts: { rounds: 4, statements: 4 },
    effective: { rounds: 4, statements: 4 },
    sources: { rounds: 3, statements: 6 },
    signInMethods: { rounds: 0, statements: 0 },
  })
})
