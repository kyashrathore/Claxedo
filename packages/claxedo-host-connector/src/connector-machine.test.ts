import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  createHostConnector,
  type AssignmentDescription,
  type ConnectorErrorStage,
  type HeartbeatResponse,
  type MachineTransport,
  type ProviderConfigRevision,
} from "./connector"
import { createFakeControlPlane, enrollFakeHost, type FakeControlPlane } from "./fake-control-plane.test-support"
import { effectiveRoots, type HostScope, type HostState } from "./host-state"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "./host-identity"
import { createMachineSealingKeyPair, hostMachineSealAad, openMachineSeal } from "./machine-seal"
import { createMachineSignedTransport } from "./machine-transport"

/**
 * Assignment discovery against the strict fake: the owner assigns, re-points,
 * retires and tightens from the control-plane side; the host learns of it
 * only through its beats. Every "acked" below is an ack the fake received and
 * turned into readiness — `cp.routable()` is what the relay would be told.
 */

async function machineHost(
  cp: FakeControlPlane,
  input: {
    allowedRoots?: string[]
    cliRoots?: string[]
    resolvePath?: (p: string) => Promise<string>
    /** What the caller does with each description list; defaults to acking everything it can. */
    onAssignments?: (descriptions: AssignmentDescription[], ack: (d: AssignmentDescription) => Promise<void>) => Promise<void>
    wrap?: (transport: MachineTransport) => MachineTransport
    sealingPublicKey?: string
    /** Stands in for the caller's store; a rejection is a host that could not write the blob. */
    onProviderConfig?: (config: ProviderConfigRevision) => Promise<void>
  } = {},
) {
  const enrolled = await enrollFakeHost(cp, { allowedRoots: input.allowedRoots ?? ["/srv"], cliRoots: input.cliRoots ?? [] })
  let state: HostState = enrolled.state
  const real = createMachineSignedTransport({
    controlPlaneUrl: cp.url,
    keys: enrolled.keys,
    enrollmentId: enrolled.enrollmentId,
    hostId: state.host_id,
    keyVersion: state.enrollment?.key_version ?? 1,
    fetch: cp.fetch,
  })
  const transport = input.wrap ? input.wrap(real) : real
  const resolvePath = input.resolvePath ?? (async (p: string) => p)
  const seen: AssignmentDescription[][] = []
  const scopes: HostScope[] = []
  const tunnels: Array<Record<string, unknown> | undefined> = []
  const errors: Array<{ stage: ConnectorErrorStage; error: unknown }> = []
  const ackFailures: unknown[] = []
  const providerConfigs: ProviderConfigRevision[] = []
  let tick: (() => void) | undefined
  const connector = createHostConnector({
    mode: "machine",
    hostId: state.host_id,
    transport,
    enrollmentId: enrolled.enrollmentId,
    heartbeatIntervalMs: 25_000,
    sessionAuthority: "managed-private",
    roots: () => effectiveRoots(state, resolvePath),
    resolvePath,
    setInterval: (fn) => {
      tick = fn
      return { cancel: () => undefined }
    },
    onScope: (scope) => {
      scopes.push(scope)
      state = { ...state, scope }
    },
    onAssignments: async (descriptions) => {
      seen.push(descriptions)
      const ack = (d: AssignmentDescription) =>
        connector.ack({ workspaceId: d.workspaceId, revision: d.revision }).catch((error: unknown) => {
          ackFailures.push(error)
        })
      if (input.onAssignments) await input.onAssignments(descriptions, ack)
      else for (const d of descriptions) await ack(d)
    },
    onServing: (tunnel) => tunnels.push(tunnel),
    onError: (stage, error) => errors.push({ stage, error }),
    ...(input.sealingPublicKey ? { sealingPublicKey: input.sealingPublicKey } : {}),
    onProviderConfig: async (config) => {
      providerConfigs.push(config)
      await input.onProviderConfig?.(config)
    },
  })
  const beats = () => cp.log.filter((entry) => entry.path === "/api/claxedo/host/enrollments/heartbeat")
  return {
    cp,
    enrolled,
    connector,
    seen,
    scopes,
    tunnels,
    errors,
    ackFailures,
    providerConfigs,
    beats,
    tick: () => tick?.(),
    state: () => state,
  }
}

describe("start", () => {
  test("acquires a generation, then beats with no acks", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)

    const state = await h.connector.start()

    expect(state).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: h.enrolled.enrollmentId } })
    expect(h.connector.generation()).toBe(1)
    expect(cp.log.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/redeem",
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    expect(h.beats()[0]?.body).toMatchObject({ generation: 1, acks: [], sessionAuthority: "managed-private" })
    expect(h.scopes).toEqual([{ revision: 1, allowed_roots: ["/srv"], visibility: "owner" }])
    expect(h.seen, "no assignments means nothing to reconcile").toEqual([])
  })

  test("endpoints are delivered once, and again only when they change", async () => {
    const cp = createFakeControlPlane()
    const endpoints: unknown[] = []
    const enrolled = await enrollFakeHost(cp)
    const connector = createHostConnector({
      mode: "machine",
      hostId: enrolled.state.host_id,
      transport: createMachineSignedTransport({
        controlPlaneUrl: cp.url,
        keys: enrolled.keys,
        enrollmentId: enrolled.enrollmentId,
        hostId: enrolled.state.host_id,
        keyVersion: 1,
        fetch: cp.fetch,
      }),
      enrollmentId: enrolled.enrollmentId,
      heartbeatIntervalMs: 25_000,
      roots: () => ["/srv"],
      resolvePath: async (p) => p,
      setInterval: () => ({ cancel: () => undefined }),
      onEndpoints: (delivered) => {
        endpoints.push(delivered)
      },
    })
    await connector.start()
    await connector.beat()
    await connector.beat()

    expect(endpoints).toEqual([
      {
        relay: { url: cp.relayUrl, jwksUrl: `${cp.relayUrl}/.well-known/jwks.json` },
        authority: { sessionAuthorityUrl: `${cp.url}/api/runtime-authority/session-authorize` },
      },
    ])
  })

  test("a revoked enrollment stops on the first beat", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    cp.revoke(h.enrolled.enrollmentId)

    const state = await h.connector.start()

    expect(state).toMatchObject({ status: "stopped", reason: "revoked", detail: expect.stringContaining("enrollment_revoked") })
    expect(h.errors.map((entry) => entry.stage)).toEqual(["acquire"])
  })

  test("a control plane that is briefly unavailable at start is an error, not a revocation", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    cp.faults.unavailable = 503

    expect(await h.connector.start()).toMatchObject({ status: "stopped", reason: "error" })
  })
})

describe("assignment discovery", () => {
  test("a folder assigned after the host started is acked within two beats and the credential covers it", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    const before = h.beats().length

    const revision = cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    expect(h.beats().length - before).toBe(2)
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [{ workspaceId: "ws_1", revision }] })
    expect(h.connector.acked()).toEqual([{ workspaceId: "ws_1", revision }])
    expect(h.tunnels.at(-1)).toMatchObject({ workspaceIds: ["ws_1"] })
    expect(h.seen).toEqual([[{ workspaceId: "ws_1", remoteDirectory: "/srv/api", revision }]])
  })

  // The credential is handed on untouched, and a consumer that serves out of
  // another process reads the machine's own enrollment out of it: nothing
  // else of the enrollment crosses that boundary.
  test("the credential reaches the caller with every field the ack wrote on it", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    expect(h.tunnels.at(-1)).toMatchObject({ enrollmentId: h.enrolled.enrollmentId })
  })

  test("a re-pointed directory is withdrawn, re-validated and re-acked at the new revision", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    const moved = cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api-v2" })
    const beatsBefore = h.beats().length
    let ackedAtDelivery: unknown
    const listener = h.connector.acked
    h.seen.length = 0
    const original = h.connector.ack.bind(h.connector)
    h.connector.ack = async (input) => {
      ackedAtDelivery ??= listener()
      return original(input)
    }
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    expect(moved).toBe(2)
    expect(ackedAtDelivery, "withdrawn before the caller was told").toEqual([])
    expect(h.seen).toEqual([[{ workspaceId: "ws_1", remoteDirectory: "/srv/api-v2", revision: 2 }]])
    const delivery = h.beats()[beatsBefore]
    const reack = h.beats()[beatsBefore + 1]
    expect(delivery?.body).toMatchObject({ acks: [{ workspaceId: "ws_1", revision: 1 }] })
    expect(reack?.body).toMatchObject({ acks: [{ workspaceId: "ws_1", revision: 2 }] })
    expect(cp.readiness.get("ws_1")).toMatchObject({ revision: 2, generation: 1 })
    expect(h.tunnels.at(-2), "the delivering beat's credential did not cover the moved workspace").toBeUndefined()
    expect(h.tunnels.at(-1)).toMatchObject({ workspaceIds: ["ws_1"] })
  })

  test("a folder outside the effective roots is never acked", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp, { allowedRoots: ["/srv", "/home"], cliRoots: ["/srv/api"] })
    await h.connector.start()

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_out", remoteDirectory: "/home/u/secret" })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_cli", remoteDirectory: "/srv/other" })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_in", remoteDirectory: "/srv/api/app" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_in"]))

    // The refused two stay pending and are refused again on each re-delivery.
    expect(h.ackFailures.slice(0, 2).map(String)).toEqual([
      expect.stringContaining("ws_cli: /srv/other is outside this host's roots"),
      expect.stringContaining("ws_out: /home/u/secret is outside this host's roots"),
    ])
    expect(new Set(h.ackFailures.map(String)).size).toBe(2)
    for (const beat of h.beats()) {
      const acks = beat.body.acks as Array<{ workspaceId: string }>
      expect(acks.map((ack) => ack.workspaceId)).not.toContain("ws_out")
      expect(acks.map((ack) => ack.workspaceId)).not.toContain("ws_cli")
    }
    expect(h.connector.acked()).toEqual([{ workspaceId: "ws_in", revision: 1 }])
  })

  test("a folder that resolves outside the roots through a symlink is refused on the resolved path", async () => {
    const cp = createFakeControlPlane()
    const links: Record<string, string> = { "/srv/link": "/home/u/elsewhere" }
    const h = await machineHost(cp, { resolvePath: async (p) => links[p] ?? p })
    await h.connector.start()

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_link", remoteDirectory: "/srv/link" })
    h.tick()
    await vi.waitFor(() => expect(h.ackFailures).toHaveLength(1))

    expect(String(h.ackFailures[0])).toContain("outside this host's roots")
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
  })

  test("a description whose preparation failed stays pending and is re-delivered: every beat for five attempts, then every tenth", async () => {
    const cp = createFakeControlPlane()
    let exists = false
    const h = await machineHost(cp, {
      resolvePath: async (p) => {
        if (p === "/srv/api" && !exists) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
        return p
      },
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    const deliveriesAfter = async () => {
      h.tick()
      await vi.waitFor(() => expect(h.beats().length).toBe(beatsBefore + 1))
      beatsBefore = h.beats().length
      return h.seen.length
    }
    let beatsBefore = h.beats().length

    const perBeat: number[] = []
    for (let beat = 1; beat <= 15; beat++) perBeat.push(await deliveriesAfter())

    expect(perBeat).toEqual([1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6])
    expect(h.ackFailures).toHaveLength(6)
    expect(String(h.ackFailures[0])).toContain("cannot be resolved")
    expect(h.connector.acked()).toEqual([])
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])

    exists = true
    for (let beat = 1; beat <= 9; beat++) expect(await deliveriesAfter()).toBe(6)
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    expect(h.seen).toHaveLength(7)
    expect(h.connector.acked()).toEqual([{ workspaceId: "ws_1", revision: 1 }])
    await h.connector.beat()
    await h.connector.beat()
    expect(h.seen).toHaveLength(7)
  })

  test("a retired assignment is unacked on the next beat", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    cp.unassign("ws_1")
    h.tick()
    await vi.waitFor(() => expect(h.connector.acked()).toEqual([]))

    expect(h.seen.at(-1)).toEqual([])
    expect(h.connector.assignments()).toEqual([])
    await h.connector.beat()
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [] })
    expect(h.tunnels.at(-1)).toBeUndefined()
  })

  test("a tightened scope arrives before the assignments it retires are validated", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp, { allowedRoots: ["/srv"] })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    // A new revision of the folder and a narrower scope reach the host in the
    // same beat (the scope is set behind the route so the retirement the
    // control plane's own update would do does not hide the case). The new
    // scope must be in force when the new revision is validated, or the host
    // would ack a folder the owner just excluded.
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    cp.enrollments.get(h.enrolled.enrollmentId)!.scope = { revision: 2, allowed_roots: ["/srv/only"], visibility: "owner" }
    h.tick()
    await vi.waitFor(() => expect(h.ackFailures).toHaveLength(1))

    expect(h.scopes.at(-1)).toEqual({ revision: 2, allowed_roots: ["/srv/only"], visibility: "owner" })
    expect(h.state().scope?.revision).toBe(2)
    expect(String(h.ackFailures[0])).toContain("outside this host's roots")
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
  })

  test("an out-of-order response cannot reinstate an older description", async () => {
    const cp = createFakeControlPlane()
    let stale: HeartbeatResponse | undefined
    let replayStale = false
    const h = await machineHost(cp, {
      wrap: (transport) => ({
        ...transport,
        heartbeat: async (input) => {
          const result = await transport.heartbeat(input)
          if (replayStale && stale) {
            replayStale = false
            return { ...result, assignments: stale.assignments, scope: stale.scope }
          }
          stale ??= result.assignments?.length ? result : undefined
          return result
        },
      }),
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api-v2" })
    h.tick()
    await vi.waitFor(() => expect(cp.readiness.get("ws_1")).toMatchObject({ revision: 2 }))
    const reconciliations = h.seen.length

    replayStale = true
    await h.connector.beat()

    expect(h.connector.acked()).toEqual([{ workspaceId: "ws_1", revision: 2 }])
    expect(h.connector.assignments()).toEqual([{ workspaceId: "ws_1", remoteDirectory: "/srv/api-v2", revision: 2 }])
    expect(h.seen).toHaveLength(reconciliations)
    await h.connector.beat()
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [{ workspaceId: "ws_1", revision: 2 }] })
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"])
  })

  test("two folders on one host stay acked independently", async () => {
    const cp = createFakeControlPlane()
    const ackedAtDelivery: unknown[] = []
    const h: Awaited<ReturnType<typeof machineHost>> = await machineHost(cp, {
      onAssignments: async (descriptions, ack) => {
        ackedAtDelivery.push(h.connector.acked())
        for (const d of descriptions) await ack(d)
      },
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_a", remoteDirectory: "/srv/a" })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_b", remoteDirectory: "/srv/b" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_a", "ws_b"]))

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_a", remoteDirectory: "/srv/a2" })
    h.tick()
    await vi.waitFor(() => expect(cp.readiness.get("ws_a")).toMatchObject({ revision: 2 }))

    expect(ackedAtDelivery.at(-1), "ws_b stayed acked while ws_a was withdrawn").toEqual([{ workspaceId: "ws_b", revision: 1 }])
    expect(h.beats().at(-1)?.body).toMatchObject({
      acks: [
        { workspaceId: "ws_a", revision: 2 },
        { workspaceId: "ws_b", revision: 1 },
      ],
    })
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_a", "ws_b"])
  })
})

describe("a host that confines no directory", () => {
  /**
   * The desktop daemon's shape: enrolled through the owner's account, so the
   * control plane hands it no scope, and serving workspace ids out of its own
   * store rather than opening the directory a description names.
   */
  async function accountHost(cp: FakeControlPlane) {
    const created = await createHostKeyPair()
    const keys = await hostKeyPairFromJwk(created.privateKeyJwk)
    const hostId = newHostId()
    const enrollment = await cp.enrollAccountHost({ hostId, publicKey: keys.publicKey })
    const scopes: HostScope[] = []
    const ackFailures: unknown[] = []
    let tick: (() => void) | undefined
    const connector = createHostConnector({
      mode: "machine",
      hostId,
      transport: createMachineSignedTransport({
        controlPlaneUrl: cp.url,
        keys,
        enrollmentId: enrollment.enrollment_id,
        hostId,
        fetch: cp.fetch,
      }),
      enrollmentId: enrollment.enrollment_id,
      heartbeatIntervalMs: 25_000,
      sessionAuthority: "local",
      setInterval: (fn) => {
        tick = fn
        return { cancel: () => undefined }
      },
      onScope: (scope) => {
        scopes.push(scope)
      },
      onAssignments: async (descriptions) => {
        for (const description of descriptions) {
          await connector
            .ack({ workspaceId: description.workspaceId, revision: description.revision })
            .catch((error: unknown) => ackFailures.push(error))
        }
      },
    })
    return { connector, enrollment, scopes, ackFailures, tick: () => tick?.() }
  }

  test("acks a description by id, with no scope delivered and no path resolved", async () => {
    const cp = createFakeControlPlane()
    const h = await accountHost(cp)
    await h.connector.start()

    // A directory no filesystem here could resolve: this host never opens it.
    cp.assign({
      enrollmentId: h.enrollment.enrollment_id,
      workspaceId: "ws_local",
      remoteDirectory: "/Users/me/does-not-exist",
    })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrollment.enrollment_id)).toEqual(["ws_local"]))

    expect(h.ackFailures).toEqual([])
    expect(h.scopes, "an account enrollment carries no roots to deliver").toEqual([])
    expect(h.connector.acked()).toEqual([{ workspaceId: "ws_local", revision: 1 }])
  })

  test("keyVersion is absent from every signed request when the enrollment never stated one", async () => {
    const cp = createFakeControlPlane()
    const h = await accountHost(cp)
    await h.connector.start()

    const machineCalls = cp.log.filter((entry) => entry.path.startsWith("/api/claxedo/host/enrollments/"))
    expect(machineCalls.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    for (const call of machineCalls) expect(call.body).not.toHaveProperty("keyVersion")
  })
})

describe("generation fencing", () => {
  test("a newer instance's acquire stops this one on its next beat as a decision", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    const clone = createMachineSignedTransport({
      controlPlaneUrl: cp.url,
      keys: h.enrolled.keys,
      enrollmentId: h.enrolled.enrollmentId,
      hostId: h.state().host_id,
      keyVersion: 1,
      fetch: cp.fetch,
    })
    expect(await clone.acquire()).toEqual({ generation: 2 })
    expect(cp.routable(h.enrolled.enrollmentId), "acquire drops the older generation's readiness").toEqual([])

    const state = await h.connector.beat()

    expect(state).toMatchObject({
      status: "stopped",
      reason: "revoked",
      detail: expect.stringContaining("enrollment_generation_superseded"),
    })
    expect(h.connector.acked()).toEqual([])
    expect(h.errors.at(-1)?.stage).toBe("heartbeat")
  })

  test("restarting before the lease expires acquires the next generation without re-enrolling", async () => {
    const cp = createFakeControlPlane()
    const first = await machineHost(cp)
    await first.connector.start()
    first.connector.close()

    const second = await machineHost(cp)
    await second.connector.start()

    expect(second.connector.generation()).toBe(1)
    expect(cp.log.filter((entry) => entry.path === "/api/claxedo/host/enrollments/redeem")).toHaveLength(2)
    expect(cp.enrollments.size).toBe(2)
  })
})

describe("serialization", () => {
  test("one beat in flight; extra beat() calls coalesce into one queued beat", async () => {
    const cp = createFakeControlPlane()
    let release: (() => void) | undefined
    let open = 0
    const h = await machineHost(cp, {
      wrap: (transport) => ({
        ...transport,
        heartbeat: async (input) => {
          open++
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return transport.heartbeat(input)
        },
      }),
    })
    const starting = h.connector.start()
    await vi.waitFor(() => expect(open).toBe(1))
    release?.()
    await starting

    const a = h.connector.beat()
    const b = h.connector.beat()
    const c = h.connector.beat()
    await vi.waitFor(() => expect(open).toBe(2))
    release?.()
    await a
    await vi.waitFor(() => expect(open).toBe(3))
    release?.()
    await Promise.all([b, c])

    expect(open, "three calls, two requests").toBe(3)
  })

  test("an ack issued from inside onAssignments rides the very next beat", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })

    await h.connector.beat()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    expect(h.beats().map((beat) => (beat.body.acks as unknown[]).length)).toEqual([0, 0, 1])
  })
})

describe("consent, withdrawal and drain", () => {
  test("an ack whose description moved on while its path was resolving is refused", async () => {
    const cp = createFakeControlPlane()
    let releaseResolve: (() => void) | undefined
    const h = await machineHost(cp, {
      onAssignments: async () => undefined,
      resolvePath: async (p) => {
        if (p === "/srv/api") await new Promise<void>((resolve) => (releaseResolve = resolve))
        return p
      },
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    await h.connector.beat()

    const acking = h.connector.ack({ workspaceId: "ws_1", revision: 1 })
    await vi.waitFor(() => expect(releaseResolve).toBeDefined())
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api-v2" })
    await h.connector.beat()
    releaseResolve?.()

    await expect(acking).rejects.toThrow(/changed while revision 1 was being validated/)
    expect(h.connector.acked()).toEqual([])
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
  })

  test("drain withdraws every ack in one final beat, so a clean exit reads offline within a round trip", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_a", remoteDirectory: "/srv/a" })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_b", remoteDirectory: "/srv/b" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_a", "ws_b"]))
    const requests = cp.log.length

    await h.connector.drain()
    h.connector.close()

    expect(cp.log.length).toBe(requests + 1)
    expect(cp.log.at(-1)).toMatchObject({ path: "/api/claxedo/host/enrollments/heartbeat", body: { acks: [] } })
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
    expect(h.tunnels.at(-1)).toBeUndefined()
    expect(h.connector.state()).toMatchObject({ status: "stopped", reason: "closed" })
    await h.connector.drain()
    expect(cp.log.length).toBe(requests + 1)
  })

  test("drain during an in-flight preparation: the late ack is refused and the final beat carries no acks", async () => {
    const cp = createFakeControlPlane()
    let releasePreparation: (() => void) | undefined
    let ackOutcome: unknown = "not attempted"
    const h: Awaited<ReturnType<typeof machineHost>> = await machineHost(cp, {
      onAssignments: async (descriptions, ack) => {
        for (const d of descriptions) {
          if (d.workspaceId === "ws_slow") {
            await new Promise<void>((resolve) => {
              releasePreparation = resolve
            })
            ackOutcome = await h.connector.ack({ workspaceId: d.workspaceId, revision: d.revision }).then(
              () => "acked",
              (error: unknown) => error,
            )
            continue
          }
          await ack(d)
        }
      },
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_fast", remoteDirectory: "/srv/fast" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_fast"]))

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_slow", remoteDirectory: "/srv/slow" })
    h.tick()
    await vi.waitFor(() => expect(releasePreparation).toBeDefined())
    const beatsBeforeDrain = h.beats().length
    let drained = false
    const draining = h.connector.drain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(drained, "drain waits for the beat that is preparing ws_slow").toBe(false)

    releasePreparation?.()
    await draining
    h.connector.close()

    expect(ackOutcome).toBeInstanceOf(Error)
    expect(String(ackOutcome)).toContain("draining")
    expect(h.beats().length, "exactly one beat after the in-flight one").toBe(beatsBeforeDrain + 1)
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [] })
    expect(cp.routable(h.enrolled.enrollmentId), "the control plane holds no readiness for the exiting host").toEqual([])
    expect(h.seen.at(-1)?.map((d) => d.workspaceId)).toEqual(["ws_fast", "ws_slow"])
    expect(h.tunnels.at(-1)).toBeUndefined()
  })

  test("while draining, a beat already in flight delivers nothing and no further beat is sent", async () => {
    const cp = createFakeControlPlane()
    let releaseBeat: (() => void) | undefined
    const h = await machineHost(cp, {
      wrap: (transport) => ({
        ...transport,
        heartbeat: async (input) => {
          const result = await transport.heartbeat(input)
          if (releaseBeat === undefined && input.acks.length > 0) {
            await new Promise<void>((resolve) => {
              releaseBeat = resolve
            })
          }
          return result
        },
      }),
    })
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))
    h.tick()
    await vi.waitFor(() => expect(releaseBeat).toBeDefined())
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api-v2" })
    const deliveries = h.seen.length
    const tunnels = h.tunnels.length
    const requests = h.beats().length

    const draining = h.connector.drain()
    h.tick()
    h.tick()
    await h.connector.beat()
    await h.connector.unack("ws_1")
    releaseBeat?.()
    await draining

    expect(h.seen.length, "the held beat's description list was not delivered").toBe(deliveries)
    expect(h.beats().length, "the held beat, then the drain beat and nothing else").toBe(requests + 1)
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [] })
    expect(h.tunnels.slice(tunnels), "the held beat's credential was not reported; the drain reports nothing served").toEqual([undefined])
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
    await expect(h.connector.ack({ workspaceId: "ws_1", revision: 1 })).rejects.toThrow(/draining/)
  })

  test("unack withdraws consent and beats", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    await h.connector.unack("ws_1")

    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
    expect(h.beats().at(-1)?.body).toMatchObject({ acks: [] })
  })
})

describe("with a real filesystem", () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  test("realpath refuses a symlink that escapes the root and accepts one that stays inside", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "connect-roots-")))
    dirs.push(base)
    const root = path.join(base, "srv")
    const outside = path.join(base, "outside")
    await mkdir(path.join(root, "inner"), { recursive: true })
    await mkdir(outside)
    await symlink(outside, path.join(root, "escape"))
    await symlink(path.join(root, "inner"), path.join(root, "alias"))
    const cp = createFakeControlPlane()
    const h = await machineHost(cp, { allowedRoots: [root], resolvePath: (p) => realpath(p) })
    await h.connector.start()

    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_escape", remoteDirectory: path.join(root, "escape") })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_alias", remoteDirectory: path.join(root, "alias") })
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_missing", remoteDirectory: path.join(root, "nope") })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_alias"]))

    expect(h.ackFailures.slice(0, 2).map(String)).toEqual([
      expect.stringContaining("ws_escape"),
      expect.stringContaining("ws_missing"),
    ])
    expect(String(h.ackFailures[1])).toContain("cannot be resolved")
    expect(new Set(h.ackFailures.map(String)).size).toBe(2)
  })

  test("a --root that is a symlink under the control plane's root cannot carry that root's authority to the link target", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "connect-roots-")))
    dirs.push(base)
    const srv = path.join(base, "srv")
    const elsewhere = path.join(base, "elsewhere")
    await mkdir(srv)
    await mkdir(path.join(elsewhere, "repo"), { recursive: true })
    await symlink(elsewhere, path.join(srv, "link"))
    const cp = createFakeControlPlane()
    const h = await machineHost(cp, { allowedRoots: [srv], cliRoots: [path.join(srv, "link")], resolvePath: (p) => realpath(p) })
    await h.connector.start()

    // Lexically `<srv>/link/repo` is under both `<srv>` and `<srv>/link`;
    // resolved it is `<elsewhere>/repo`, outside the owner's root.
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_escape", remoteDirectory: path.join(srv, "link", "repo") })
    h.tick()
    await vi.waitFor(() => expect(h.ackFailures).toHaveLength(1))

    expect(String(h.ackFailures[0])).toContain("outside this host's roots")
    expect(await effectiveRoots(h.state(), (p) => realpath(p))).toEqual([])
    expect(cp.routable(h.enrolled.enrollmentId)).toEqual([])
  })
})

/**
 * The owner pushes provider credentials; the machine declares a key to be
 * sealed to, stores what arrives, and only then tells the control plane it
 * has it. Every assertion below is against the fake's own recorded state —
 * `cp.providerConfigAckedRevision` is exactly what the route writes.
 */
describe("provider configuration", () => {
  const PLAINTEXT = JSON.stringify({
    version: 1,
    providers: { openai: { baseUrl: "https://model.test", placeholder: "sk-pushed", authMode: "bearer" } },
  })

  async function configuredHost(input: Parameters<typeof machineHost>[1] = {}) {
    const cp = createFakeControlPlane()
    const sealing = await createMachineSealingKeyPair()
    const host = await machineHost(cp, { sealingPublicKey: sealing.publicKey, ...input })
    await host.connector.start()
    return { ...host, sealing }
  }

  test("the first beat declares the key the owner seals to", async () => {
    const host = await configuredHost()
    expect(host.cp.sealingPublicKey(host.enrolled.enrollmentId)).toBe(host.sealing.publicKey)
    expect(host.beats()[0]?.body.sealingPublicKey).toBe(host.sealing.publicKey)
  })

  test("a machine that declares no key can be sealed nothing", async () => {
    const cp = createFakeControlPlane()
    const host = await machineHost(cp)
    await host.connector.start()
    expect(cp.sealingPublicKey(host.enrolled.enrollmentId)).toBeUndefined()
    await expect(cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)).rejects.toMatchObject({
      code: "host_sealing_key_undeclared",
    })
  })

  test("a pushed revision reaches the machine sealed, opens with its own key, and is acked once", async () => {
    const host = await configuredHost()
    const revision = await host.cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)
    await host.connector.beat()

    expect(host.providerConfigs).toHaveLength(1)
    const delivered = host.providerConfigs[0]
    expect(delivered.revision).toBe(revision)
    expect(delivered.sealed).not.toBeNull()
    expect(delivered.sealed).not.toContain("sk-pushed")
    expect(
      await openMachineSeal(
        host.sealing.privateKeyJwk,
        delivered.sealed ?? "",
        hostMachineSealAad({ enrollmentId: host.enrolled.enrollmentId, revision }),
      ),
    ).toBe(PLAINTEXT)

    expect(host.connector.providerConfigRevision()).toBe(revision)
    await host.connector.beat()
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).toBe(revision)
    expect(host.providerConfigs).toHaveLength(1)
  })

  test("a revision the host could not store is never acked and arrives again", async () => {
    let writes = 0
    const host = await configuredHost({
      onProviderConfig: async () => {
        writes++
        if (writes === 1) throw new Error("disk full")
      },
    })
    const revision = await host.cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)

    await host.connector.beat()
    expect(host.connector.providerConfigRevision()).toBeUndefined()
    expect(host.errors.filter((entry) => entry.stage === "provider-config")).toHaveLength(1)
    await host.connector.beat()
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).not.toBe(revision)

    expect(host.providerConfigs).toHaveLength(2)
    expect(host.connector.providerConfigRevision()).toBe(revision)
    await host.connector.beat()
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).toBe(revision)
  })

  test("a store that keeps failing does not stop the machine serving what it already serves", async () => {
    const host = await configuredHost({
      allowedRoots: ["/srv"],
      onProviderConfig: () => Promise.reject(new Error("read-only file system")),
    })
    await host.cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)
    host.cp.assign({ enrollmentId: host.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/app" })
    await host.connector.beat()
    expect(host.connector.acked()).toEqual([{ workspaceId: "ws_1", revision: 1 }])
    // The ack queues its own beat; that beat is what writes the readiness row.
    await host.connector.beat()
    expect(host.cp.routable(host.enrolled.enrollmentId)).toEqual(["ws_1"])
  })

  test("the owner's withdrawal is a revision like any other and lands within one beat", async () => {
    const host = await configuredHost()
    await host.cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)
    await host.connector.beat()

    const withdrawn = await host.cp.pushProviderConfig(host.enrolled.enrollmentId, null)
    await host.connector.beat()
    expect(host.providerConfigs[1]).toEqual({ revision: withdrawn, sealed: null })
    await host.connector.beat()
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).toBe(withdrawn)
  })

  test("a revision below the one the machine holds is neither applied nor acked", async () => {
    const host = await configuredHost()
    const withdrawn = await host.cp.pushProviderConfig(host.enrolled.enrollmentId, PLAINTEXT)
    await host.connector.beat()
    const replayed = host.cp.providerConfig(host.enrolled.enrollmentId)
    expect(replayed).toEqual({ revision: withdrawn, sealed: expect.any(String) })

    const rotated = await host.cp.pushProviderConfig(
      host.enrolled.enrollmentId,
      JSON.stringify({
        version: 1,
        providers: { openai: { baseUrl: "https://model.test", placeholder: "sk-rotated", authMode: "bearer" } },
      }),
    )
    await host.connector.beat()
    await host.connector.beat()
    expect(host.providerConfigs).toHaveLength(2)
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).toBe(rotated)

    host.cp.replayProviderConfig(host.enrolled.enrollmentId, replayed!)
    await host.connector.beat()
    expect(host.providerConfigs).toHaveLength(2)
    expect(host.connector.providerConfigRevision()).toBe(rotated)
    await host.connector.beat()
    expect(host.cp.providerConfigAckedRevision(host.enrolled.enrollmentId)).toBe(rotated)
  })

  test("a host that already holds a revision declares it and is sent nothing", async () => {
    const cp = createFakeControlPlane()
    const sealing = await createMachineSealingKeyPair()
    const first = await machineHost(cp, { sealingPublicKey: sealing.publicKey })
    await first.connector.start()
    const revision = await cp.pushProviderConfig(first.enrolled.enrollmentId, PLAINTEXT)
    await first.connector.beat()
    await first.connector.beat()
    first.connector.close()

    const restarted = await machineHost(cp, { sealingPublicKey: sealing.publicKey })
    expect(restarted.enrolled.enrollmentId).not.toBe(first.enrolled.enrollmentId)
    const holder = createHostConnector({
      mode: "machine",
      hostId: first.enrolled.state.host_id,
      transport: createMachineSignedTransport({
        controlPlaneUrl: cp.url,
        keys: first.enrolled.keys,
        enrollmentId: first.enrolled.enrollmentId,
        hostId: first.enrolled.state.host_id,
        fetch: cp.fetch,
      }),
      enrollmentId: first.enrolled.enrollmentId,
      heartbeatIntervalMs: 25_000,
      setInterval: () => ({ cancel: () => undefined }),
      sealingPublicKey: sealing.publicKey,
      providerConfigRevision: revision,
      onProviderConfig: () => {
        throw new Error("the control plane re-sent a revision this host already holds")
      },
    })
    await holder.start()
    expect(holder.providerConfigRevision()).toBe(revision)
    expect(cp.providerConfigAckedRevision(first.enrolled.enrollmentId)).toBe(revision)
    holder.close()
  })
})
