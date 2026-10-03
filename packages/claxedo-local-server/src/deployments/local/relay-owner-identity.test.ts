import { afterEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { credentialSnapshot } from "@claxedo/agent-runtime-contract"
import { stopHostServing } from "@claxedo/host-serving/serving"
import { CredentialSelectionError, selectSessionCredentials } from "@claxedo/harness/registry"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER = "usr_machine_owner"

const relayed = new Map([
  ["owner-rht", { actor_id: "actor:owner", user_id: OWNER }],
  ["member-rht", { actor_id: "actor:member", user_id: "usr_member" }],
])

vi.mock("@claxedo/workspace-runtime/relay", async (importOriginal) => ({
  ...await importOriginal<typeof import("@claxedo/workspace-runtime/relay")>(),
  hostTunnelPreOpenQueueFromEnv: () => ({}),
  startWorkspaceRelayHostTunnel: (options: { onEvent: (event: { type: string }) => void }) => {
    options.onEvent({ type: "connecting" })
    return { close: () => {}, updateRegistration: async () => {} }
  },
  createRelayHostTokenVerifier: () => async ({ token }: { token: string }) => {
    const person = relayed.get(token)
    return person && {
      ...person, actor_kind: "human", actor_public_id: person.actor_id, actor_name: person.actor_id,
      principal_kind: "user", org_id: "org_1", workspace_id: WS, host_id: "host_machine-1", role: "owner",
    }
  },
}))

afterEach(() => {
  stopHostServing()
  delete process.env.CLAXEDO_DATA_DIR
})

test("the enrolled owner's first relayed session spends the machine owner's account, as their direct one does", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-owner-"))
  process.env.CLAXEDO_DATA_DIR = root
  const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
  const { putCredential } = await import("@claxedo/server-core/credentials/registry")
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  const { createLocalCredentialBroker } = await import("../../credentials/broker")
  const { hostCredentialProjectAuth, localMachineOwnerUserId } = await import("../../workspace/host-provider-config")
  const { resetHostEnrolledOwner } = await import("@claxedo/host-serving/serving")
  const { HostServingRoutes } = await import("../../workspace/host-serving-routes")
  const { localHostRelayActor } = await import("./host-session-authority")
  setBackendOverride(createTestBackend())
  try {
    await putCredential({ owner: "local", provider_id: "openai", kind: "api_key", source: "managed", secret: "machine-owner-openai" })
    const broker = createLocalCredentialBroker({ dataDir: root, brokerOrigin: "http://127.0.0.1:48300", machineOwnerUserId: localMachineOwnerUserId })
    const projectAuth = hostCredentialProjectAuth(broker.projectAuth)
    const desktop = { placement: "desktop" as const, machineOwnerUserId: "", canUseOwnLogin: true }
    const select = async (owner: Parameters<typeof selectSessionCredentials>[1]) => selectSessionCredentials({
      ...desktop, ...credentialSnapshot(await projectAuth({ workspaceId: WS }), {})!, leaseGeneration: "test", providerIds: piCredentialProviderIDs("openai"),
    }, owner)
    const request = (token: string) => new Request(`http://127.0.0.1:2593/workspaces/${WS}/session`, { headers: { authorization: `Bearer ${token}` } })

    await expect(select({ kind: "person", userId: OWNER })).rejects.toThrow(CredentialSelectionError)

    const served = await HostServingRoutes().request("/", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: {
        hostTunnelToken: "host-tunnel-token", tokenExpiresAt: Date.now() + 300_000, jti: "jti-1", hostId: "host_machine-1",
        enrollmentId: "enr_this_machine", generation: 0, ownerActorId: "actor_owner", ownerUserId: OWNER, workspaceIds: [WS], relayUrl: "https://relay.claxedo.test",
      } }),
    })
    expect(served.status).toBe(200)

    const owner = await localHostRelayActor(request("owner-rht"), WS)
    expect(owner?.userId).toBe(OWNER)
    const relayedSession = await select({ kind: "person", userId: owner!.userId! })
    const directSession = await select({ kind: "machine-owner" })
    expect(relayedSession).toEqual(directSession)
    expect(relayedSession.machineLoginAllowed).toBe(true)
    const openai = relayedSession.providers.openai
    if (!openai || "unavailable" in openai) throw new Error("the machine owner's account was not projected")
    expect((await broker.authority.resolve(openai.baseUrl.split("/bindings/")[1]))?.value).toBe("machine-owner-openai")

    const member = await localHostRelayActor(request("member-rht"), WS)
    await expect(select({ kind: "person", userId: member!.userId! })).rejects.toThrow(CredentialSelectionError)
  } finally {
    resetHostEnrolledOwner()
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
