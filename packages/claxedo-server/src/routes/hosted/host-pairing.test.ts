import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { HostPairingRoutes } from "./host-pairing"

const ORIGIN = "https://app.claxedo.test"
const CODE = "K7QM4PXD9R2TWB6HJ3NF"
const authConfig = { enabled: true, issuer: "https://issuer.example.test", jwksUrl: "https://issuer.example.test/.well-known/jwks.json" } as const
const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

const machine = { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.2", folder: "/home/ubuntu/code/app" }

function routes(overrides: Record<string, unknown> = {}) {
  const authority = {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    auditAllow: vi.fn(async () => {}),
    createHostPairing: vi.fn(async () => ({ pairingId: "pair_1", code: CODE, expiresAt: 9_000 })),
    recordHostPairingProgress: vi.fn(async () => ({ pairingId: "pair_1", ownerUserId: "user_1" })),
    redeemHostPairing: vi.fn(async () => ({ resumed: false, pairing_id: "pair_1", owner_user_id: "user_1", enrollment: { enrollment_id: "enr_1", host_id: "host_1" } })),
    approveHostPairing: vi.fn(async () => ({ hostId: "host_1", ownerUserId: "user_1", folder: machine.folder, workspaceId: undefined })),
    assignWorkspaceHost: vi.fn(async () => ({ assigned: true })),
    recordHostPairingWorkspace: vi.fn(async (_auth: unknown, input: { pairingId: string; workspaceId: string }) => ({ pairing_id: input.pairingId, stage: "approved", workspace_id: input.workspaceId })),
    denyHostPairing: vi.fn(async () => ({ hostId: "host_1", ownerUserId: "user_1" })),
    hostPairing: vi.fn(async () => ({ pairing_id: "pair_1", stage: "denied" })),
    ...overrides,
  }
  const hostChanged = vi.fn(async (_input: { ownerUserId: string; hostId: string }) => undefined)
  const machineChanged = vi.fn(async (_input: { ownerUserId: string; hostId?: string; pairingId?: string }) => undefined)
  const app = HostPairingRoutes({ authority } as unknown as ControlPlaneServices, { authConfig, verifier, controlPlaneOrigin: ORIGIN, hostChanged, machineChanged } as never)
  const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer user_1" }) =>
    app.request(`http://control.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  return { authority, hostChanged, machineChanged, post }
}

describe("pairing routes", () => {
  test("minting answers the code and the commands that fetch this plane's scripts", async () => {
    const { post, authority } = routes()
    const response = await post("/", {})
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      pairing_id: "pair_1",
      code: CODE,
      expires_at: 9_000,
      commands: {
        posix: `curl -fsSL ${ORIGIN}/api/claxedo/connect | sh -s -- ${CODE}`,
        windows: `& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1))) ${CODE}`,
      },
    })
    expect(authority.auditAllow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "host_pairing.created" }))
    expect((await post("/", {}, {})).status, "a code is minted only for a signed-in person").toBe(401)
  })

  test("what a machine reports with only its code tells the minting person's app, and the redeem names where they answer it", async () => {
    const { post, machineChanged } = routes()
    expect((await post("/progress", { code: CODE, hostname: "build-box", os: "Ubuntu 24.04" }, {})).status).toBe(200)
    const redeemed = await post("/redeem", { code: CODE, hostId: "host_1", publicKey: "{}", signature: "sig", machine }, {})
    expect(redeemed.status, await redeemed.clone().text()).toBe(200)
    expect(await redeemed.json()).toMatchObject({ pairing_id: "pair_1", approval_url: `${ORIGIN}/settings/machines` })
    expect(machineChanged.mock.calls.map(([input]) => input)).toEqual([
      { ownerUserId: "user_1", pairingId: "pair_1" },
      { ownerUserId: "user_1", pairingId: "pair_1" },
    ])
  })

  test("approval assigns the folder as a workspace named after it, records it on the pairing, and rings the machine and the app", async () => {
    const { post, authority, hostChanged, machineChanged } = routes()
    const response = await post("/pair_1/approve", { displayName: "studio" })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(authority.approveHostPairing).toHaveBeenCalledWith(expect.anything(), { pairingId: "pair_1", displayName: "studio" })
    const [, assigned] = authority.assignWorkspaceHost.mock.calls[0] as unknown as [unknown, { workspaceId: string; hostId: string; displayName: string; remoteDirectory: string }]
    expect(assigned).toMatchObject({ hostId: "host_1", displayName: "app", remoteDirectory: machine.folder })
    expect(assigned.workspaceId).toMatch(/^ws_[0-9a-f]{32}$/)
    expect(await response.json()).toEqual({ pairing: { pairing_id: "pair_1", stage: "approved", workspace_id: assigned.workspaceId } })
    expect(hostChanged).toHaveBeenCalledWith({ ownerUserId: "user_1", hostId: "host_1" })
    expect(machineChanged).toHaveBeenCalledWith({ ownerUserId: "user_1", pairingId: "pair_1" })
  })

  test("a second approval of an approval whose workspace was never recorded reuses no new id when one was recorded", async () => {
    const { post, authority } = routes({ approveHostPairing: vi.fn(async () => ({ hostId: "host_1", ownerUserId: "user_1", folder: machine.folder, workspaceId: "ws_given" })) })
    expect((await post("/pair_1/approve", {})).status).toBe(200)
    expect(authority.assignWorkspaceHost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws_given" }))
  })

  test("a denial rings the machine it revoked and the app", async () => {
    const { post, hostChanged, machineChanged } = routes()
    const response = await post("/pair_1/deny", {})
    expect(await response.json()).toEqual({ pairing: { pairing_id: "pair_1", stage: "denied" } })
    expect(hostChanged).toHaveBeenCalledWith({ ownerUserId: "user_1", hostId: "host_1" })
    expect(machineChanged).toHaveBeenCalledWith({ ownerUserId: "user_1", pairingId: "pair_1" })
  })

  test("one code gets five tries a minute, whoever sends them", async () => {
    const { post } = routes()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await post("/progress", { code: CODE, hostname: "h", os: "o" }, {})).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })
})
