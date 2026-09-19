import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { redeemInvitation } from "@claxedo/host-connector/bootstrap"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "@claxedo/host-connector/host-identity"
import { createMachineSealingKeyPair, hostMachineSealAad, openMachineSeal } from "@claxedo/host-connector/machine-seal"
import { createMachineSignedTransport } from "@claxedo/host-connector/machine-transport"
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
    readFile: (file) => fs.readFile(file, "utf8"),
  }
  return { deps, lines }
}

/**
 * A machine enrolled through the real bootstrap and serving through the real
 * signed transport, so the list carries a real fingerprint, host id and the
 * acks the machine actually sent.
 */
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
  const enrollmentId = outcome.state.enrollment!.enrollment_id
  const transport = createMachineSignedTransport({
    controlPlaneUrl: cp.url,
    keys: await hostKeyPairFromJwk(keys.privateKeyJwk),
    enrollmentId,
    hostId: state.host_id,
    keyVersion: 1,
    fetch: cp.fetch,
  })
  const { generation } = await transport.acquire()
  /** One beat acking every current assignment of this machine, as the running host would. */
  const ackAll = async () => {
    const acks = [...cp.assignments.values()]
      .filter((assignment) => assignment.enrollment_id === enrollmentId)
      .map((assignment) => ({ workspaceId: assignment.workspace_id, revision: assignment.revision }))
    await transport.heartbeat({ generation, acks })
  }
  /** One beat declaring a fresh sealing key, as the running host does on every beat; the private half opens what the owner then pushes. */
  const declareSealingKey = async () => {
    const pair = await createMachineSealingKeyPair()
    await transport.heartbeat({ generation, acks: [], sealingPublicKey: pair.publicKey })
    return pair
  }
  return { hostId: state.host_id, enrollmentId, ackAll, declareSealingKey }
}

const SECRET = "sk-owner-secret-0123456789"
const PROVIDERS = {
  "claude-sdk": { baseUrl: "https://broker.example/b/1", placeholder: SECRET, authMode: "bearer" },
  "codex-app-server": { baseUrl: "https://api.openai.com", placeholder: `${SECRET}-codex`, authMode: "bearer", apiPath: "/v1" },
}

async function providerFile(providers: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-push-"))
  const file = path.join(dir, "providers.json")
  await fs.writeFile(file, JSON.stringify(providers === undefined ? { providers: PROVIDERS } : providers))
  return file
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
    expect(lines[2]).toMatch(new RegExp(`^build-box\\s+${machine.enrollmentId}\\s+${machine.hostId}\\s+\\S{16}\\s+1\\s+yes\\s+/srv$`))
    // Paused: the lease may still be live, but its beats are refused, so it is not online.
    cp.pause(machine.enrollmentId, true)
    await host(["list"], deps)
    expect(lines[4]).toMatch(/\s1\s+paused\s+\/srv$/)
    cp.pause(machine.enrollmentId, false)
    cp.enrollments.get(machine.enrollmentId)!.expires_at = Date.now() - 1
    await host(["list"], deps)
    expect(lines[6]).toMatch(/\s1\s+no\s+\/srv$/)
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
      paused_at: undefined,
      assignments: [],
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

    // The same folder on the same machine re-points the same workspace.
    await host(["assign", "--machine", machine.enrollmentId, "/srv/api"], deps)
    expect(cp.assignments.size).toBe(1)
    expect(cp.assignments.get(workspaceId)).toMatchObject({ revision: 2, display_name: "API" })

    await expect(host(["assign", "--machine", "build-box", "/elsewhere"], deps)).rejects.toThrow("host_assignment_outside_scope")

    await machine.ackAll()
    await host(["unassign", "--machine", "build-box", "/srv/api"], deps)
    expect(cp.assignments.size).toBe(0)
    expect(lines.at(-1)).toBe(`build-box no longer serves /srv/api (${workspaceId} retired)`)
    await expect(host(["unassign", "--machine", "build-box", "/srv/api"], deps)).rejects.toThrow("build-box is not assigned /srv/api")
  })

  test("an offline machine assigned the same folder twice has one workspace, and it is unassignable before any ack", async () => {
    const machine = await enrolledMachine(cp, "sleeper")
    const { deps, lines } = owner(cp)

    await host(["assign", "--machine", "sleeper", "/srv/api", "--name", "API"], deps)
    await host(["assign", "--machine", "sleeper", "/srv/api"], deps)

    expect(cp.assignments.size).toBe(1)
    const [workspaceId] = [...cp.assignments.keys()]
    expect(cp.assignments.get(workspaceId)).toMatchObject({ host_id: machine.hostId, revision: 2, display_name: "API" })
    expect(cp.readiness.size, "never acked").toBe(0)

    await host(["unassign", "--machine", "sleeper", "/srv/api"], deps)

    expect(cp.assignments.size).toBe(0)
    expect(lines.at(-1)).toBe(`sleeper no longer serves /srv/api (${workspaceId} retired)`)
  })

  test("a trailing slash or a `..` names the same folder: assign re-points the existing workspace and unassign finds it", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const { deps, lines } = owner(cp)
    await host(["assign", "--machine", "build-box", "/srv/app"], deps)
    const [workspaceId] = [...cp.assignments.keys()]

    await host(["assign", "--machine", "build-box", "/srv/app/"], deps)
    await host(["assign", "--machine", "build-box", "/srv/./tmp/../app"], deps)

    expect(cp.assignments.size, "one folder, one workspace").toBe(1)
    expect(cp.assignments.get(workspaceId)).toMatchObject({ remote_directory: "/srv/app", revision: 3 })
    const sent = cp.log.filter((entry) => entry.method === "POST" && entry.path.endsWith("/host-assignment")).map((entry) => entry.body)
    expect(sent.map((body) => body.remoteDirectory), "the control plane is sent the normalized form").toEqual(["/srv/app", "/srv/app", "/srv/app"])
    expect(sent.map((body) => body.repoName)).toEqual(["app", "app", "app"])
    expect(lines.at(-1)).toBe(`build-box will serve /srv/app as ${workspaceId} (app); it acks on its next beat`)

    await machine.ackAll()
    await host(["unassign", "--machine", "build-box", "/srv/app/"], deps)
    expect(cp.assignments.size).toBe(0)
    expect(lines.at(-1)).toBe(`build-box no longer serves /srv/app (${workspaceId} retired)`)
    await expect(host(["assign", "--machine", "build-box", "/srv/../etc"], deps)).rejects.toThrow("host_assignment_outside_scope")
  })

  test("two assignments already at one folder are refused with their ids rather than one being picked", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const { deps } = owner(cp)
    cp.assign({ hostId: machine.hostId, workspaceId: "ws_a", remoteDirectory: "/srv/app" })
    cp.assign({ hostId: machine.hostId, workspaceId: "ws_b", remoteDirectory: "/srv/app/" })

    await expect(host(["assign", "--machine", "build-box", "/srv/app"], deps)).rejects.toThrow(
      "build-box has 2 workspaces at /srv/app (ws_a, ws_b); this command cannot tell which is meant — retire one at the control plane first",
    )
    await expect(host(["unassign", "--machine", "build-box", "/srv/app/"], deps)).rejects.toThrow("ws_a, ws_b")
    expect(cp.assignments.size, "nothing was written").toBe(2)
  })

  test("the same directory string on two machines is two workspaces; unassign on one leaves the other's", async () => {
    const box1 = await enrolledMachine(cp, "box1")
    const box2 = await enrolledMachine(cp, "box2")
    const { deps } = owner(cp)
    await host(["assign", "--machine", "box1", "/srv/api"], deps)
    await box1.ackAll()
    const [ws1] = [...cp.assignments.keys()]

    await host(["assign", "--machine", "box2", "/srv/api"], deps)

    expect(cp.assignments.size).toBe(2)
    const ws2 = [...cp.assignments.keys()].find((id) => id !== ws1)!
    expect(cp.assignments.get(ws1)).toMatchObject({ host_id: box1.hostId, remote_directory: "/srv/api", revision: 1 })
    expect(cp.assignments.get(ws2)).toMatchObject({ host_id: box2.hostId, remote_directory: "/srv/api", revision: 1 })
    await box2.ackAll()

    // box2 cannot retire what box1 serves, and only retires its own.
    await host(["unassign", "--machine", "box2", "/srv/api"], deps)
    expect([...cp.assignments.keys()]).toEqual([ws1])
    await expect(host(["unassign", "--machine", "box2", "/srv/api"], deps)).rejects.toThrow("box2 is not assigned /srv/api")
    expect(cp.assignments.get(ws1)).toMatchObject({ host_id: box1.hostId, revision: 1 })

    // A folder box1 was assigned but never acked (offline) is not what a new
    // assignment on box2 re-points either.
    cp.assign({ hostId: box1.hostId, workspaceId: "ws_pending", remoteDirectory: "/srv/web" })
    await host(["assign", "--machine", "box2", "/srv/web"], deps)
    expect(cp.assignments.get("ws_pending")).toMatchObject({ host_id: box1.hostId, revision: 1 })
    expect([...cp.assignments.values()].filter((entry) => entry.remote_directory === "/srv/web")).toHaveLength(2)
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

  test("push-config seals the file's providers for the machine's declared key; the output names providers and never the secret", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const sealing = await machine.declareSealingKey()
    const { deps, lines } = owner(cp)
    const file = await providerFile(undefined)

    await host(["push-config", "--machine", "build-box", "--from-file", file], deps)

    const sent = cp.log.find((entry) => entry.method === "POST" && entry.path.endsWith("/provider-config"))
    expect(sent?.path).toBe(`/api/claxedo/host/enrollments/${machine.enrollmentId}/provider-config`)
    expect(sent?.body).toEqual({ providers: PROVIDERS })
    const stored = cp.providerConfig(machine.enrollmentId)
    expect(stored?.revision).toBe(1)
    expect(stored?.sealed).toMatch(/^mseal1\./)
    expect(stored?.sealed).not.toContain(SECRET)
    const opened = await openMachineSeal(sealing.privateKeyJwk, stored!.sealed!, hostMachineSealAad({ enrollmentId: machine.enrollmentId, revision: 1 }))
    expect(JSON.parse(opened)).toEqual({ version: 1, providers: PROVIDERS })
    expect(lines.at(-1)).toBe("build-box: sealed claude-sdk, codex-app-server (revision 1); the machine applies it on its next beat")
    expect(lines.join("\n")).not.toContain(SECRET)
    await fs.rm(path.dirname(file), { recursive: true, force: true })
  })

  test("push-config --clear withdraws: a new revision whose blob is null", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    await machine.declareSealingKey()
    const { deps, lines } = owner(cp)
    const file = await providerFile(undefined)
    await host(["push-config", "--machine", machine.enrollmentId, "--from-file", file], deps)

    await host(["push-config", "--machine", "build-box", "--clear"], deps)

    const sent = cp.log.filter((entry) => entry.method === "POST" && entry.path.endsWith("/provider-config")).at(-1)
    expect(sent?.body).toEqual({ providers: {} })
    expect(cp.providerConfig(machine.enrollmentId)).toEqual({ revision: 2, sealed: null })
    expect(lines.at(-1)).toBe("build-box: provider configuration withdrawn (revision 2); the machine drops it within one beat")
    await fs.rm(path.dirname(file), { recursive: true, force: true })
  })

  test("push-config to a machine that has declared no sealing key is refused with what to do, and nothing is stored", async () => {
    const machine = await enrolledMachine(cp, "build-box")
    const { deps } = owner(cp)
    const file = await providerFile(undefined)

    await expect(host(["push-config", "--machine", "build-box", "--from-file", file], deps)).rejects.toThrow(
      "build-box has not beaten since it learned to receive configuration, so there is no sealing key to seal to yet",
    )

    expect(cp.providerConfig(machine.enrollmentId)).toBeUndefined()
    await fs.rm(path.dirname(file), { recursive: true, force: true })
  })

  test("push-config takes the credential from a file only: --api-key is not an option, and the file must hold providers", async () => {
    await enrolledMachine(cp, "build-box")
    const { deps } = owner(cp)
    await expect(host(["push-config", "--machine", "build-box", "--api-key", SECRET], deps)).rejects.toThrow("Unknown host option: --api-key")
    await expect(host(["push-config", "--machine", "build-box"], deps)).rejects.toThrow("exactly one of --from-file FILE or --clear")
    const file = await providerFile(undefined)
    await expect(host(["push-config", "--machine", "build-box", "--from-file", file, "--clear"], deps)).rejects.toThrow("exactly one of")
    await expect(host(["push-config", "--from-file", file], deps)).rejects.toThrow("--machine <name|enrollment_id> is required")
    const empty = await providerFile({ providers: {} })
    await expect(host(["push-config", "--machine", "build-box", "--from-file", empty], deps)).rejects.toThrow("at least one provider")
    await fs.writeFile(empty, "{not json")
    await expect(host(["push-config", "--machine", "build-box", "--from-file", empty], deps)).rejects.toThrow("is not a JSON file")
    expect(cp.log.filter((entry) => entry.path.endsWith("/provider-config"))).toEqual([])
    await fs.rm(path.dirname(file), { recursive: true, force: true })
    await fs.rm(path.dirname(empty), { recursive: true, force: true })
  })

  test("an unauthenticated owner is refused by the control plane, and unknown subcommands by the CLI", async () => {
    const { deps, lines } = owner(cp, "not-the-owner")
    await expect(host(["list"], deps)).rejects.toThrow("unauthorized")
    await expect(host(["bogus"], deps)).rejects.toThrow("Unknown host subcommand: bogus")
    await host([], deps)
    expect(lines[0]).toContain("claxedo host invite --name N --root DIR...")
  })
})
