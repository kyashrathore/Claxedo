import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { ControlPlaneServices } from "../../authority/services"
import { memorySandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { mintCloudSessionRowsGrant, verifyCloudSessionRowsGrant } from "../../session/cloud-session-rows-grant"
import { CloudSessionRowsRoutes } from "./cloud-session-rows"

const publisher = { workspaceId: "ws_cloud", hostId: "host_cloud", epoch: 7, userId: "usr_owner", actorId: "act_owner", orgId: "org_owner", projectId: "prj_owner" }
const body = { rows: [{ workspaceId: "ws_cloud", sessionId: "ses_cloud", createdAt: 1, updatedAt: 2, status: { kind: "idle", awaitingInput: false, at: 2 } }], removed: [] }

async function fixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  let time = 1_800_000_000_000
  const now = () => time
  const passes = memorySandboxPassRegister({ now })
  const token = (await mintCloudSessionRowsGrant(publisher, signingEnv, { register: passes, now })).token
  const publish = vi.fn(async () => ({ accepted: 1, refused: [] }))
  const active = vi.fn(async () => true)
  const app = CloudSessionRowsRoutes({ authority: { publishCloudSessionRows: publish, cloudSessionRowsPublisherActive: active } } as unknown as ControlPlaneServices,
    { signingEnv, passes, now })
  const post = (path: string, payload: unknown = body, bearer: string | undefined = token) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(payload),
  })
  return { post, publish, active, signingEnv, passes, now, advance: () => { time += 60 * 60_000 } }
}

describe("cloud row publication route", () => {
  test("uses only the producer pass identity and validates the publication", async () => {
    const input = await fixture()
    expect((await input.post("/")).status).toBe(200)
    expect(input.publish).toHaveBeenCalledWith(publisher, body)
    expect((await input.post("/", { ...body, hostId: "another-host" })).status).toBe(400)
    expect((await input.post("/", body, "an-owner-or-machine-token")).status).toBe(401)
    expect(input.publish).toHaveBeenCalledTimes(1)
  })
  test("renews only the same live lease and does not extend revoked grants", async () => {
    const input = await fixture()
    input.advance()
    expect((await input.post("/")).status).toBe(401)
    const response = await input.post("/renew", {})
    expect(response.status).toBe(200)
    const next = await response.json() as { token: string; expiresAt: number }
    await expect(verifyCloudSessionRowsGrant(next.token, input.signingEnv, input)).resolves.toEqual(publisher)
    input.active.mockResolvedValue(false)
    expect((await input.post("/renew", {})).status).toBe(403)
    await input.passes.revoke({ workspaceId: publisher.workspaceId, reason: "workspace_deleted" })
    expect((await input.post("/renew", {})).status).toBe(401)
  })
})
