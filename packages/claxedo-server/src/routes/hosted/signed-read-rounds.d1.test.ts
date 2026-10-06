import { afterEach, expect, test } from "vitest"
import { countD1Rounds, type D1Rounds } from "../../test-support/d1-rounds"
import { hostedCoreD1App } from "../../test-support/hosted-core-d1-app"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const READY = { status: "ready" as const, hostId: "host_1", epoch: 1, sandboxId: "sb_1", url: "https://sandbox.test", homeRegion: "us-east" }

async function signedReader() {
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
    routes: { productWorkspace: { sandboxStart: async () => READY } },
  })
  const alice = await app.person("alice")
  const orgId = ((await app.call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
  await app.authority.createWorkspace(alice.auth, { workspaceId: "ws_acme", orgId, displayName: "acme", backing: "cloud-vm", repoUrl: "https://github.com/acme/app" })
  const rounds = async (method: string, path: string, body?: unknown) => {
    counted!.reset()
    const response = await app.call(alice.token, method, path, body)
    expect(response.status, `${method} ${path} ${JSON.stringify(response.body)}`).toBe(200)
    return { rounds: counted!.rounds(), statements: counted!.statements() }
  }
  return { app, alice, rounds }
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
