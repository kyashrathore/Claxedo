import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { redeemInvitation } from "@claxedo/host-connector/bootstrap"
import { createHostKeyPair, newHostId } from "@claxedo/host-connector/host-identity"
import { newHostState } from "@claxedo/host-connector/host-state"
import { createFakeConnectControlPlane, OWNER_TOKEN, type FakeControlPlane } from "../connect/fake-control-plane.test-support"
import { connectStateStore } from "../connect/paths"
import { hostCommand as host, inviteOutput, parseExpires, resolveMachine, type HostDeps, type Machine } from "./host"

function owner(cp: FakeControlPlane, token = OWNER_TOKEN) {
  const lines: string[] = []
  const deps: HostDeps = {
    request: cp.request,
    token: async () => token,
    controlPlaneUrl: cp.url,
    log: (line) => lines.push(line),
    now: () => Date.now(),
  }
  return { deps, lines }
}

/** A machine enrolled through the real bootstrap, so the list carries a real fingerprint and host id. */
async function enrolledMachine(cp: FakeControlPlane, name: string, roots = ["/srv"]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-owner-"))
  const invitation = await cp.createInvitation({ displayName: name, scope: { allowed_roots: roots, visibility: "owner" } })
  const tokenFile = path.join(home, "invite.txt")
  await fs.writeFile(tokenFile, invitation.token)
  const keys = await createHostKeyPair()
  const state = newHostState({
    hostId: newHostId(),
    privateKeyJwk: keys.privateKeyJwk,
    controlPlaneUrl: cp.url,
    cliRoots: [],
    storageRoot: path.join(home, "ws"),
  })
  const outcome = await redeemInvitation({ tokenFile, store: connectStateStore(home), state, keys, fetch: cp.fetch, displayName: name })
  await fs.rm(home, { recursive: true, force: true })
  return { hostId: state.host_id, enrollmentId: outcome.state.enrollment!.enrollment_id }
}

describe("claxedo host", () => {
  let cp: FakeControlPlane
  beforeEach(() => {
    cp = createFakeConnectControlPlane()
  })

  test("invite mints a scoped single-use token and prints it once with the connect line", async () => {
    const { deps, lines } = owner(cp)
    await host(["invite", "--name", "build-box", "--root", "/srv", "--root", "/opt/repos", "--expires", "30m", "--org-visible"], deps)
    const sent = cp.log.find((entry) => entry.path === "/api/claxedo/host/invitations")
    expect(sent?.body).toEqual({
      displayName: "build-box",
      scope: { allowed_roots: ["/srv", "/opt/repos"], visibility: "org" },
      expiresInMs: 30 * 60_000,
    })
    const token = lines.find((line) => line.startsWith("chx_inv_1."))
    expect(token).toBeDefined()
    expect(lines.filter((line) => line.includes(token!))).toHaveLength(1)
    expect(lines).toContain("Invitation for build-box (roots: /srv, /opt/repos; visibility: org)")
    expect(lines).toContain("  claxedo connect --token-file <file> --root /srv --root /opt/repos --install-service")
    expect(lines.some((line) => /^Expires: \d{4}-/.test(line))).toBe(true)
  })

  test("invite needs a name and at least one root; --expires is <n>m|h|d", async () => {
    const { deps } = owner(cp)
    await expect(host(["invite", "--root", "/srv"], deps)).rejects.toThrow("--name is required")
    await expect(host(["invite", "--name", "x"], deps)).rejects.toThrow("at least one --root")
    await expect(host(["invite", "--name", "x", "--root", "srv"], deps)).rejects.toThrow("absolute")
    expect(parseExpires(undefined)).toBe(60 * 60_000)
    expect(parseExpires("2h")).toBe(2 * 60 * 60_000)
    expect(parseExpires("1d")).toBe(24 * 60 * 60_000)
    expect(() => parseExpires("soon")).toThrow("--expires wants")
    expect(cp.log).toHaveLength(0)
  })

  test("invite output is complete when the control plane omits expiry", () => {
    expect(inviteOutput({ token: "chx_inv_1.a.b", expiresAt: 0, name: "n", roots: ["/srv"], visibility: "owner" })).toEqual([
      "Invitation for n (roots: /srv; visibility: owner)",
      "Expires: 1970-01-01T00:00:00.000Z",
      "",
      "Token (shown once; single use):",
      "chx_inv_1.a.b",
      "",
      "On the machine, save the token to a file readable only by the service user, then:",
      "  claxedo connect --token-file <file> --root /srv --install-service",
    ])
  })

  test("list prints every enrolled machine with its generation and whether its lease is live", async () => {
    const { deps, lines } = owner(cp)
    await host(["list"], deps)
    expect(lines).toEqual(["No machines are enrolled. `claxedo host invite` mints an invitation."])
    const machine = await enrolledMachine(cp, "build-box")
    await host(["list"], deps)
    expect(lines[1]).toMatch(/^NAME\s+ENROLLMENT\s+HOST\s+FINGERPRINT\s+GEN\s+ONLINE\s+ROOTS$/)
    expect(lines[2]).toMatch(new RegExp(`^build-box\\s+${machine.enrollmentId}\\s+${machine.hostId}\\s+\\S{16}\\s+0\\s+yes\\s+/srv$`))
    cp.enrollments.get(machine.enrollmentId)!.expires_at = Date.now() - 1
    await host(["list"], deps)
    expect(lines[4]).toMatch(/\s0\s+no\s+\/srv$/)
  })

  test("--machine resolves an enrollment id first, then an exact display name, and refuses ambiguity with the ids", () => {
    const row = (enrollment_id: string, display_name: string): Machine => ({
      enrollment_id,
      display_name,
      host_id: `host_${enrollment_id}`,
      public_key_fingerprint: undefined,
      serving_generation: undefined,
      expires_at: undefined,
      last_seen_at: undefined,
      enrolled_via: undefined,
      scope: undefined,
    })
    const machines = [row("enr_1", "alpha"), row("enr_2", "beta"), row("enr_3", "beta"), row("enr_4", "enr_1")]
    expect(resolveMachine(machines, "enr_1").enrollment_id).toBe("enr_1")
    expect(resolveMachine(machines, "alpha").enrollment_id).toBe("enr_1")
    expect(() => resolveMachine(machines, "Alpha")).toThrow("No machine named Alpha")
    expect(() => resolveMachine(machines, "beta")).toThrow("2 machines are named beta; pass the enrollment id instead: enr_2, enr_3")
  })

  test("assign and unassign drive the owner's host-assignment routes for the resolved machine", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const { deps, lines } = owner(cp)
    await expect(host(["assign", "/srv/api"], deps)).rejects.toThrow("--machine <name|enrollment_id> is required")
    await expect(host(["assign", "--machine", "build-box"], deps)).rejects.toThrow("a directory on the machine is required")
    await expect(host(["assign", "--machine", "build-box", "srv/api"], deps)).rejects.toThrow("absolute path on the machine")

    await host(["assign", "--machine", "build-box", "/srv/api", "--name", "API"], deps)
    const assigned = cp.log.find((entry) => entry.method === "POST" && entry.path.endsWith("/host-assignment"))
    expect(assigned?.path).toMatch(/^\/api\/workspace\/ws_[0-9a-f]{32}\/host-assignment$/)
    expect(assigned?.body).toEqual({ hostId: machine.hostId, displayName: "API", repoName: "api", remoteDirectory: "/srv/api" })
    const workspaceId = [...cp.assignments.keys()][0]
    expect(lines.at(-1)).toBe(`build-box will serve /srv/api as ${workspaceId} (API); it acks on its next beat`)

    await host(["assign", "--machine", machine.enrollmentId, "/srv/api"], deps)
    expect(cp.assignments.size).toBe(1)
    expect(cp.assignments.get(workspaceId)).toMatchObject({ revision: 2, display_name: "API" })

    await expect(host(["assign", "--machine", "build-box", "/elsewhere"], deps)).rejects.toThrow("remote_directory_outside_scope")

    const other = await enrolledMachine(cp, "other-box")
    await expect(host(["unassign", "--machine", "other-box", "/srv/api"], deps)).rejects.toThrow(
      `/srv/api (${workspaceId}) is assigned to host ${machine.hostId}, not to other-box`,
    )
    expect(other.hostId).not.toBe(machine.hostId)
    await host(["unassign", "--machine", "build-box", "/srv/api"], deps)
    expect(cp.assignments.size).toBe(0)
    expect(lines.at(-1)).toBe(`build-box no longer serves /srv/api (${workspaceId} retired)`)
    await expect(host(["unassign", "--machine", "build-box", "/srv/api"], deps)).rejects.toThrow("No user-hosted workspace is registered for /srv/api")
  })

  test("scope patches the roots and visibility; revoke deletes the machine through the devices route", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const { deps, lines } = owner(cp)
    await host(["assign", "--machine", "build-box", "/srv/api"], deps)
    await host(["scope", "--machine", "build-box", "--root", "/srv/web", "--org-visible"], deps)
    const patched = cp.log.find((entry) => entry.method === "PATCH")
    expect(patched?.path).toBe(`/api/claxedo/host/enrollments/${machine.enrollmentId}/scope`)
    expect(patched?.body).toEqual({ allowed_roots: ["/srv/web"], visibility: "org" })
    expect(cp.assignments.size).toBe(0)
    expect(lines.at(-1)).toContain("roots /srv/web (visibility org)")
    await expect(host(["scope", "--machine", "build-box"], deps)).rejects.toThrow("at least one --root")

    await host(["revoke", "--machine", "build-box"], deps)
    const revoked = cp.log.find((entry) => entry.method === "DELETE" && entry.path.startsWith("/api/claxedo/remote-access/devices/"))
    expect(revoked?.path).toBe(`/api/claxedo/remote-access/devices/${machine.hostId}`)
    expect(cp.enrollments.get(machine.enrollmentId)?.revoked_at).toBeDefined()
    await expect(host(["revoke", "--machine", "build-box"], deps)).rejects.toThrow("No machine named build-box")
  })

  test("an unauthenticated owner is refused by the control plane, and unknown subcommands by the CLI", async () => {
    const { deps, lines } = owner(cp, "not-the-owner")
    await expect(host(["list"], deps)).rejects.toThrow("unauthorized")
    await expect(host(["bogus"], deps)).rejects.toThrow("Unknown host subcommand: bogus")
    await host([], deps)
    expect(lines[0]).toContain("claxedo host invite --name N --root DIR...")
  })
})
