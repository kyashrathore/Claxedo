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
} from "./connector"
import { createFakeControlPlane, enrollFakeHost, type FakeControlPlane } from "./fake-control-plane.test-support"
import { effectiveRoots, type HostScope, type HostState } from "./host-state"
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
  let tick: (() => void) | undefined
  const connector = createHostConnector({
    mode: "machine",
    hostId: state.host_id,
    keys: enrolled.keys,
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
      keys: enrolled.keys,
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

  test("a re-pointed directory is withdrawn, re-validated and re-acked at the new revision", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()
    cp.assign({ enrollmentId: h.enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    h.tick()
    await vi.waitFor(() => expect(cp.routable(h.enrolled.enrollmentId)).toEqual(["ws_1"]))

    // The owner moves the workspace to another folder. The readiness row still
    // names revision 1, so the credential in the very beat that delivers
    // revision 2 no longer covers the workspace.
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

    // Beats 1–5 each deliver the pending description again; 6–14 do not; 15 does.
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
    // Acked: nothing is pending, so a further beat delivers nothing.
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

    // A response carrying the revision-1 snapshot lands after revision 2 was
    // applied and acked.
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

describe("mode boundaries", () => {
  test("share/unshare are refused in machine mode, ack/unack in account mode", async () => {
    const cp = createFakeControlPlane()
    const h = await machineHost(cp)
    await h.connector.start()

    await expect(h.connector.shareWorkspace({ workspaceId: "ws" })).rejects.toThrow(/use ack/)
    await expect(h.connector.unshareWorkspace("ws")).rejects.toThrow(/use unack/)

    const account = createHostConnector({
      hostId: "h",
      keys: h.enrolled.keys,
      transport: {
        createRequest: async () => ({ request_id: "r", nonce: "n", expires_at: 1 }),
        enroll: async () => ({ enrollment_id: "e", host_id: "h", expires_at: 1 }),
        heartbeat: async () => ({ expires_at: 2 }),
      },
      heartbeatIntervalMs: 1_000,
      setInterval: () => ({ cancel: () => undefined }),
    })
    await expect(account.ack({ workspaceId: "ws", revision: 1 })).rejects.toThrow(/machine-mode/)
    await expect(account.unack("ws")).rejects.toThrow(/machine-mode/)
  })

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
    // Stopped: a second drain sends nothing.
    await h.connector.drain()
    expect(cp.log.length).toBe(requests + 1)
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
