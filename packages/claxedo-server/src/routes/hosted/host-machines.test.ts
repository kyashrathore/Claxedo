import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { HostEnrollmentListRow } from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { ControlPlaneServices } from "../../authority/services"
import { HostMachineRoutes } from "./host-machines"

const NOW = 1_800_000_000_000
const authConfig = { enabled: true, issuer: "https://issuer.example.test", jwksUrl: "https://issuer.example.test/.well-known/jwks.json" } as const
const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function enrollment(overrides: Partial<HostEnrollmentListRow> = {}): HostEnrollmentListRow {
  return {
    enrollment_id: "enr_box",
    display_name: "build-box",
    host_id: "host_box",
    public_key_fingerprint: "fp",
    key_version: 1,
    enrolled_via: "invitation",
    last_seen_at: NOW,
    expires_at: NOW + 60_000,
    serving_generation: 1,
    assignments: [{ workspace_id: "ws_app", remote_directory: "/home/ada/app", revision: 1 }],
    acked: [{ workspaceId: "ws_app", revision: 1 }],
    scope: { allowed_roots: ["/home/ada/app"], revision: 2 },
    provider_config_revision: 0,
    provider_config_acked_revision: 0,
    sealing_key_declared: true,
    provider_config_providers: [],
    provider_config_rekeyed: false,
    ...overrides,
  }
}

function routes(machines: HostEnrollmentListRow[]) {
  const authority = {
    listHostEnrollments: vi.fn(async () => machines),
    openWorkspace: vi.fn(async () => { throw new Error("no machine should be reached") }),
  }
  const app = HostMachineRoutes({ authority, relay: {} } as unknown as ControlPlaneServices, { authConfig, verifier, env: {}, now: () => NOW } as never)
  const read = (enrollmentId: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer user_ada" }) =>
    app.request(`http://control.test/${enrollmentId}/folders`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  return { authority, read }
}

describe("host machine routes", () => {
  test("a machine that is not the caller's, paused, offline or serving nothing is refused before anything reaches it", async () => {
    const cases: Array<[HostEnrollmentListRow[], number, string]> = [
      [[], 404, "machine_not_found"],
      [[enrollment({ paused_at: NOW - 1 })], 409, "machine_paused"],
      [[enrollment({ expires_at: NOW - 1 })], 409, "machine_offline"],
      [[enrollment({ acked: [] })], 409, "machine_serves_nothing"],
      [[enrollment({ acked: [{ workspaceId: "ws_app", revision: 0 }] })], 409, "machine_serves_nothing"],
    ]
    for (const [machines, status, code] of cases) {
      const { read, authority } = routes(machines)
      const response = await read("enr_box", { read: "home" })
      expect(response.status, code).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
      expect(authority.openWorkspace).not.toHaveBeenCalled()
    }
  })

  test("only a signed-in person may ask, and only for one level, a search or the home folder", async () => {
    const { read, authority } = routes([enrollment()])
    expect((await read("enr_box", { read: "home" }, {})).status).toBe(401)
    for (const body of [{ read: "everything" }, { read: "children" }, { read: "search", directory: "/home/ada", query: "x", limit: 500 }, { read: "home", directory: "/" }]) {
      expect((await read("enr_box", body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(authority.listHostEnrollments).not.toHaveBeenCalled()
  })
})
