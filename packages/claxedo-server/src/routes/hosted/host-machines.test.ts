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

function routes(machines: HostEnrollmentListRow[], options: Record<string, unknown> = {}) {
  const authority = {
    listHostEnrollments: vi.fn(async () => machines),
    openWorkspace: vi.fn(async () => { throw new Error("no machine should be reached") }),
  }
  const app = HostMachineRoutes({ authority, relay: {} } as unknown as ControlPlaneServices, { authConfig, verifier, env: {}, now: () => NOW, ...options } as never)
  const post = (operation: string) => (enrollmentId: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer user_ada" }) =>
    app.request(`http://control.test/${enrollmentId}/${operation}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  return { authority, read: post("folders"), clone: post("clone") }
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

  test("a clone names one repository and its folder, a URL git may clone, and a private one only through a connection that reads it", async () => {
    const unread = { ok: false, status: 404, code: "connection_not_found" }
    const repositoryForAuth = vi.fn(async () => unread)
    const machineRepositoryClone = vi.fn()
    const { clone, authority } = routes([enrollment()], {
      connections: { repositoryForAuth },
      repositoryVisibility: async () => "unreadable",
      machineRepositoryClones: { machineRepositoryClone },
    })
    const directory = "/home/ada/beta"
    for (const body of [{ directory }, { directory, repoUrl: "https://example.test/beta.git", connectionId: "conn", repo: { fullName: "acme/beta" } }, { directory, connectionId: "conn" }]) {
      expect((await clone("enr_box", body)).status, JSON.stringify(body)).toBe(400)
    }
    const refused = async (body: unknown) => {
      const response = await clone("enr_box", body)
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code]
    }
    expect(await refused({ directory, repoUrl: "file:///etc" })).toEqual([400, "repository_url_invalid"])
    expect(await refused({ directory, repoUrl: "https://github.com/acme/private" })).toEqual([403, "repository_connection_required"])
    expect(await refused({ directory, connectionId: "conn", repo: { fullName: "acme/private" } })).toEqual([404, "connection_not_found"])
    expect(machineRepositoryClone).not.toHaveBeenCalled()
    expect(authority.openWorkspace).not.toHaveBeenCalled()
  })

  test("a private repository a connection reads is not cloned onto a machine by a plane that cannot broker it", async () => {
    const repositoryForAuth = vi.fn(async () => ({ ok: true, connectionId: "conn", repository: { id: "1", name: "private", fullName: "acme/private", cloneUrl: "https://github.com/acme/private.git", private: true, permissions: { read: true, write: false } } }))
    const { clone, authority } = routes([enrollment()], { connections: { repositoryForAuth }, repositoryVisibility: async () => "unreadable" })
    const response = await clone("enr_box", { directory: "/home/ada/private", connectionId: "conn", repo: { fullName: "acme/private" } })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "repository_broker_unavailable" } })
    expect(authority.openWorkspace).not.toHaveBeenCalled()
  })
})
