import { afterEach, expect, test } from "vitest"
import { piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { credentialSnapshot } from "@claxedo/agent-sdk-runtime"
import { adoptConnectedHostOwner, CONNECTED_HOST_PLACEMENT, installHostProviderConfigAuthority, setHostProviderConfig } from "@claxedo/host-serving/runtime"
import { resetHostEnrolledOwner } from "@claxedo/host-serving/serving"
import { CredentialSelectionError, selectSessionCredentials } from "@claxedo/harness/registry"
import { projectRuntimeAuth } from "@claxedo/server-core/agent-config/index"
import { serializeHostProviderConfig } from "@claxedo/server-core/credentials/host-provider-config"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER = "usr_machine_owner"

const noRuntimes = { applyRuntimeConfig: async () => {} }

afterEach(() => {
  resetHostEnrolledOwner()
  setHostProviderConfig(null)
})

async function select(owner: Parameters<typeof selectSessionCredentials>[1]) {
  return selectSessionCredentials({
    ...CONNECTED_HOST_PLACEMENT, ...credentialSnapshot(await projectRuntimeAuth({ scope: "local", workspaceId: WS }), {})!,
    leaseGeneration: "test", providerIds: piCredentialProviderIDs("openai"),
  }, owner)
}

test("a connected host's enrolled owner is its machine owner through the relay from the first request, before any push", async () => {
  installHostProviderConfigAuthority()
  await expect(select({ kind: "person", userId: OWNER })).rejects.toThrow(CredentialSelectionError)

  await adoptConnectedHostOwner(OWNER, noRuntimes)
  const relayed = await select({ kind: "person", userId: OWNER })
  expect(relayed).toEqual(await select({ kind: "machine-owner" }))
  expect(relayed.machineLoginAllowed).toBe(true)
  await expect(select({ kind: "person", userId: "usr_member" })).rejects.toThrow(CredentialSelectionError)

  setHostProviderConfig(serializeHostProviderConfig({ openai: { baseUrl: "https://model.test", placeholder: "owner-key", authMode: "api-key" } }, OWNER))
  const pushed = await select({ kind: "person", userId: OWNER })
  expect(pushed).toEqual(await select({ kind: "machine-owner" }))
  expect(pushed.providers.openai).toMatchObject({ placeholder: "owner-key" })
})

test("a push held from before a restart survives the first ack naming the same owner", async () => {
  installHostProviderConfigAuthority()
  setHostProviderConfig(serializeHostProviderConfig({ openai: { baseUrl: "https://model.test", placeholder: "owner-key", authMode: "api-key" } }, OWNER))

  await adoptConnectedHostOwner(OWNER, noRuntimes)

  expect((await select({ kind: "person", userId: OWNER })).providers.openai).toMatchObject({ placeholder: "owner-key" })
})

test("re-enrolling to another person drops the earlier owner's push; a failed re-apply keeps the new owner and the next ack retries it", async () => {
  installHostProviderConfigAuthority()
  await adoptConnectedHostOwner(OWNER, noRuntimes)
  setHostProviderConfig(serializeHostProviderConfig({ openai: { baseUrl: "https://model.test", placeholder: "owner-key", authMode: "api-key" } }, OWNER))

  await expect(adoptConnectedHostOwner("usr_next_owner", { applyRuntimeConfig: async () => { throw new Error("runtime down") } }))
    .rejects.toThrow("runtime down")
  expect(await select({ kind: "person", userId: "usr_next_owner" })).toMatchObject({ providers: {}, machineLoginAllowed: true })
  await expect(select({ kind: "person", userId: OWNER })).rejects.toThrow(CredentialSelectionError)

  let applied = 0
  const counting = { applyRuntimeConfig: async () => { applied += 1 } }
  await adoptConnectedHostOwner("usr_next_owner", counting)
  await adoptConnectedHostOwner("usr_next_owner", counting)
  expect(applied).toBe(1)
})
