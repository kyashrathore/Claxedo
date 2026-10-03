import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { sessionCleanupGrantContribution } from "./cleanup-grant"
import { mintSessionCleanupCapability, SESSION_CLEANUP_AUDIENCE, verifySessionCleanupCapability } from "../cleanup-capability"

const owner = { userId: "user-a", actorId: "actor-a", orgId: "org-a", projectId: "project-a" }
const root = { ...owner, workspaceId: "workspace-a" }

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const passes = memorySandboxPassRegister()
  const minted = await mintSessionCleanupCapability(root, signingEnv, { register: passes })
  let currentOwner = owner
  let enabled = true
  const contribution = sessionCleanupGrantContribution({ signingEnv, passes, workspaceOwner: async () => currentOwner, enabled: async () => enabled })
  const renew = (token: string | undefined = minted.token) => contribution.routes.request("/renew", { method: "POST", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) })
  return { signingEnv, passes, minted, renew, owner: (value: typeof owner) => { currentOwner = value }, enabled: (value: boolean) => { enabled = value } }
}

describe("session cleanup capability renewal", () => {
  test("renews only under the dedicated audience and register", async () => {
    const f = await fixture()
    const response = await f.renew()
    expect(response.status).toBe(200)
    const body = await response.json() as { token: string; expiresAt: number }
    expect(body.token).not.toBe(f.minted.token)
    expect(await verifySessionCleanupCapability(body.token, f.signingEnv, { revoked: f.passes.revoked })).toEqual(root)
    expect(await f.passes.outstanding({ orgId: root.orgId, audience: SESSION_CLEANUP_AUDIENCE })).toHaveLength(2)
  })

  test("refuses revoked or absent capabilities", async () => {
    const f = await fixture()
    expect((await f.renew("")).status).toBe(401)
    await f.passes.revoke({ workspaceId: root.workspaceId, audience: SESSION_CLEANUP_AUDIENCE, reason: "withdrawn" })
    expect((await f.renew()).status).toBe(401)
  })

  test("refuses owner replacement and disabled Sessions before minting", async () => {
    const f = await fixture()
    f.owner({ ...owner, actorId: "actor-b" })
    expect((await f.renew()).status).toBe(403)
    f.owner(owner)
    f.enabled(false)
    expect((await f.renew()).status).toBe(403)
    expect(await f.passes.outstanding({ orgId: root.orgId, audience: SESSION_CLEANUP_AUDIENCE })).toHaveLength(1)
  })
})
