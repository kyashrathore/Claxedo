import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { mintSandboxPass } from "../platform/auth/sandbox-pass"
import { mintCloudSessionRowsGrant, verifyCloudSessionRowsGrant, verifyCloudSessionRowsRenewalGrant } from "./cloud-session-rows-grant"

const publisher = { workspaceId: "ws_cloud", hostId: "host_cloud", epoch: 7, userId: "usr_owner", actorId: "act_owner", orgId: "org_owner", projectId: "prj_owner" }

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  let time = 1_800_000_000_000
  const now = () => time
  const passes = memorySandboxPassRegister({ now })
  const grant = await mintCloudSessionRowsGrant(publisher, env, { register: passes, now, ttlSeconds: 60 })
  return { env, now, passes, grant, advance: (to: number) => { time = to } }
}

describe("cloud session producer grant", () => {
  test("retained expired proof is renewal-only and cannot revive after revocation and pruning", async () => {
    const input = await fixture()
    input.advance(input.grant.expiresAt)
    await expect(verifyCloudSessionRowsGrant(input.grant.token, input.env, input)).rejects.toThrow()
    await expect(verifyCloudSessionRowsRenewalGrant(input.grant.token, input.env, input)).resolves.toMatchObject({ publisher })
    await input.passes.revoke({ workspaceId: publisher.workspaceId, reason: "producer_ended" })
    await mintSandboxPass({ audience: "other", scope: publisher, operations: ["read"], register: input.passes, now: input.now }, input.env, (detail) => new Error(detail))
    await expect(verifyCloudSessionRowsRenewalGrant(input.grant.token, input.env, input)).rejects.toThrow("unknown or revoked")
    const unknown = await mintSandboxPass({ audience: "claxedo-cloud-session-rows", scope: publisher, operations: ["publish"], extra: { host_id: publisher.hostId, lease_epoch: "7", actor_id: publisher.actorId }, now: input.now }, input.env, (detail) => new Error(detail))
    await expect(verifyCloudSessionRowsRenewalGrant(unknown.token, input.env, input)).rejects.toThrow("unknown or revoked")
  })
  test("holds the exact launch fence and has an isolated audience", async () => {
    const { env, now, passes, grant } = await fixture()
    await expect(verifyCloudSessionRowsGrant(grant.token, env, { passes, now })).resolves.toEqual(publisher)
    const user = await mintSandboxPass({ audience: "workspace-runtime-owner", scope: publisher, operations: ["sessions"], now }, env, (detail) => new Error(detail))
    await expect(verifyCloudSessionRowsGrant(user.token, env, { passes, now })).rejects.toThrow()
  })
  test("expiry and workspace revocation end publication", async () => {
    const expired = await fixture()
    expired.advance(expired.grant.expiresAt)
    await expect(verifyCloudSessionRowsGrant(expired.grant.token, expired.env, expired)).rejects.toThrow()
    const revoked = await fixture()
    await revoked.passes.revoke({ workspaceId: publisher.workspaceId, reason: "workspace_deleted" })
    await expect(verifyCloudSessionRowsGrant(revoked.grant.token, revoked.env, revoked)).rejects.toThrow()
  })
  test("refuses an invalid or absent launch epoch", async () => {
    const input = await fixture()
    await expect(mintCloudSessionRowsGrant({ ...publisher, epoch: 0 }, input.env, { register: input.passes })).rejects.toThrow("positive lease epoch")
  })
})
