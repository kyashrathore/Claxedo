import { afterEach, expect, test, vi } from "vitest"
import { countD1Rounds, type D1Rounds } from "../test-support/d1-rounds"
import { hostedCoreD1App } from "../test-support/hosted-core-d1-app"
import { createControlPlaneRelayProvider } from "@claxedo/server-core/adapters/relay/index"
import { recordRelayRuntimeToken } from "../authority/relay-token-record"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const READY = { status: "ready" as const, hostId: "host_1", epoch: 1, sandboxId: "sb_1", url: "https://sandbox.test", homeRegion: "us-east" }

/**
 * The composer's harness status of a workspace pays one round for the
 * principal, one for the workspace the caller may open, one for the caller's
 * actor beside the runtime target (a machine workspace's host is read in the
 * same round), and two for the one runtime token's record, then reads the
 * runtime's identity and health over the relay together.
 */
test("a workspace's harness status answers in five serial control-plane rounds and one relay round trip", async () => {
  let counted: D1Rounds | undefined
  let authority: Parameters<typeof recordRelayRuntimeToken>[0] | undefined
  const runtimeAccessTokenSigner = async () => ({ runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: `jti_${crypto.randomUUID()}` })
  const provider = createControlPlaneRelayProvider({
    relay: { relayUrl: "https://relay.test" },
    runtimeAccessTokenSigner,
    hostTunnelTokenSigner: async () => { throw new Error("no host tunnel in this test") },
    targetLookup: async () => ({ found: false }),
    recordRuntimeAccessToken: async (input: Parameters<typeof recordRelayRuntimeToken>[1]) => await recordRelayRuntimeToken(authority!, input),
  } as never)
  const app = await hostedCoreD1App(disposers, {
    database: (database) => {
      counted = countD1Rounds(database)
      return counted.database
    },
    services: {
      relay: { relayUrl: "https://relay.test", runtimeAccessTokenSigner, provider },
      sandbox: { sandboxManager: { target: async () => READY } },
    } as never,
  })
  authority = app.authority as never
  const alice = await app.person("alice")
  const orgId = ((await app.call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
  await app.authority.createWorkspace(alice.auth, { workspaceId: "ws_acme", orgId, displayName: "acme", backing: "cloud-vm", repoUrl: "https://github.com/acme/app" })
  let inFlight = 0
  let relayRounds = 0
  const relayed: string[] = []
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input)
    relayed.push(url.pathname)
    if (inFlight === 0) relayRounds += 1
    inFlight += 1
    await new Promise((resolve) => setTimeout(resolve, 80))
    inFlight -= 1
    return Response.json(url.pathname.endsWith("/global/health") ? { workspaceId: "ws_acme" } : { ok: true, status: "ready", harness: { kind: "native", harnessId: "pi" }, model: "anthropic/claude" })
  })
  counted!.reset()
  const response = await app.call(alice.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body, JSON.stringify(response.body)).toMatchObject({ ready: true, harness: { kind: "native", harnessId: "pi" }, model: "anthropic/claude" })
  expect({ rounds: counted!.rounds(), relayRounds, relayed: relayed.toSorted() }).toEqual({
    rounds: 5,
    relayRounds: 1,
    relayed: ["/workspaces/ws_acme/api/wr/health", "/workspaces/ws_acme/global/health"],
  })
})
