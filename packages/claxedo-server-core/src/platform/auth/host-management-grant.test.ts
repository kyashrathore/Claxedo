import { describe, expect, test } from "vitest"
import { createLocalJWKSet, exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { HostManagementGrantConfigurationError, mintHostManagementGrant, verifyHostManagementGrant } from "./host-management-grant"
import { mintSandboxPass } from "./sandbox-pass"
import { resolveMintKid } from "./runtime-access-token"

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const jwk = { ...(await exportJWK(key.publicKey)), alg: "EdDSA", kid: await resolveMintKid(env, key.privateKey) }
  return { env, keys: createLocalJWKSet({ keys: [jwk] }) }
}

const grant = {
  ownerUserId: "user-1",
  orgId: "org-1",
  enrollmentId: "enrollment-1",
  hostId: "host-1",
  operation: "folders.read",
  destination: "/home/ada/code",
} as const

describe("host management grant", () => {
  test("names the person, the enrollment, one operation and its destination, for one minute", async () => {
    const { env, keys } = await fixture()
    const now = Date.now()
    const minted = await mintHostManagementGrant(grant, env, { now: () => now })
    expect(minted.expiresAt).toBe(Math.floor(now / 1_000) * 1_000 + 60_000)
    expect(await verifyHostManagementGrant(minted.token, keys, { now: () => now })).toMatchObject({ ...grant, expiresAt: minted.expiresAt })
  })

  test("is refused once it expired, under another key, or as another audience's pass", async () => {
    const { env, keys } = await fixture()
    const other = await fixture()
    const now = Date.now()
    const minted = await mintHostManagementGrant(grant, env, { now: () => now })
    expect(await verifyHostManagementGrant(minted.token, keys, { now: () => now + 120_000 })).toBeUndefined()
    expect(await verifyHostManagementGrant(minted.token, other.keys, { now: () => now })).toBeUndefined()
    const broker = await mintSandboxPass({
      audience: "claxedo-owner-broker",
      scope: { userId: grant.ownerUserId, orgId: grant.orgId, enrollmentId: grant.enrollmentId },
      operations: ["folders.read"],
      extra: { host_id: grant.hostId, destination: grant.destination },
    }, env, (name) => new Error(name))
    expect(await verifyHostManagementGrant(broker.token, keys)).toBeUndefined()
  })

  test("is refused for a workspace's scope, an unknown operation or no destination", async () => {
    const { env, keys } = await fixture()
    const mint = (input: Parameters<typeof mintSandboxPass>[0]) => mintSandboxPass(input, env, (name) => new Error(name))
    const audience = "claxedo-host-management"
    const workspace = await mint({ audience, scope: { userId: "user-1", orgId: "org-1", workspaceId: "ws_1" }, operations: ["folders.read"], extra: { host_id: "host-1", destination: "/x" } })
    const unknown = await mint({ audience, scope: { userId: "user-1", orgId: "org-1", enrollmentId: "enrollment-1" }, operations: ["format-disk"], extra: { host_id: "host-1", destination: "/x" } })
    const two = await mint({ audience, scope: { userId: "user-1", orgId: "org-1", enrollmentId: "enrollment-1" }, operations: ["folders.read", "clone"], extra: { host_id: "host-1", destination: "/x" } })
    const nowhere = await mint({ audience, scope: { userId: "user-1", orgId: "org-1", enrollmentId: "enrollment-1" }, operations: ["clone"], extra: { host_id: "host-1" } })
    for (const token of [workspace, unknown, two, nowhere]) expect(await verifyHostManagementGrant(token.token, keys)).toBeUndefined()
  })

  test("refuses to mint without the plane's signing key", async () => {
    await expect(mintHostManagementGrant(grant, {})).rejects.toBeInstanceOf(HostManagementGrantConfigurationError)
  })
})
