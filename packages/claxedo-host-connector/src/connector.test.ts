import { describe, expect, test, vi } from "vitest"
import { createHostConnector, type ConnectorErrorStage, type HostSessionAuthority, type MachineTransport } from "./connector"
import { createFakeControlPlane, enrollFakeHost } from "./fake-control-plane.test-support"
import { createHostKeyPair, enrollmentPayload, hostKeyPairFromJwk } from "./host-identity"
import { createMachineSignedTransport } from "./machine-transport"

/**
 * The connector's lifecycle against the strict fake: what a beat does to the
 * lease, when a failed beat is a decision and when it is a disruption, and
 * what an answer that lands after its era ended is allowed to write.
 * Assignment discovery is `connector-machine.test.ts`.
 */

const LEASE_MS = 60_000

async function machineHost(
  input: {
    sessionAuthority?: HostSessionAuthority
    wrap?: (transport: MachineTransport) => MachineTransport
  } = {},
) {
  // One clock for the fake and the transport: the fake refuses a request
  // whose timestamp is more than 60 s from its own time, and the lease it
  // returns is computed from that time.
  const clock = { now: Date.now() }
  const cp = createFakeControlPlane({ now: () => clock.now })
  const enrolled = await enrollFakeHost(cp)
  const real = createMachineSignedTransport({
    controlPlaneUrl: cp.url,
    keys: enrolled.keys,
    enrollmentId: enrolled.enrollmentId,
    hostId: enrolled.state.host_id,
    keyVersion: 1,
    fetch: cp.fetch,
    now: () => clock.now,
  })
  const ticks: Array<() => void> = []
  const cancels = { count: 0 }
  const errors: Array<{ stage: ConnectorErrorStage; error: unknown }> = []
  const renewals: Array<{ expires_at: number }> = []
  const connector = createHostConnector({
    mode: "machine",
    hostId: enrolled.state.host_id,
    transport: input.wrap ? input.wrap(real) : real,
    enrollmentId: enrolled.enrollmentId,
    heartbeatIntervalMs: 25_000,
    ...(input.sessionAuthority ? { sessionAuthority: input.sessionAuthority } : {}),
    setInterval: (fn) => {
      ticks.push(fn)
      return {
        cancel: () => {
          cancels.count++
        },
      }
    },
    onError: (stage, error) => errors.push({ stage, error }),
    onLeaseRenewed: (state) => renewals.push(state.enrollment),
  })
  return {
    cp,
    clock,
    enrollmentId: enrolled.enrollmentId,
    connector,
    ticks,
    tick: () => ticks.at(-1)?.(),
    cancels,
    errors,
    renewals,
    beats: cp.beats,
    acquires: () => cp.log.filter((entry) => entry.path === "/api/claxedo/host/enrollments/acquire"),
  }
}

/**
 * Heartbeat answers the test releases by hand.
 *
 * The fake answers at once and the wrap parks that answer until `release`,
 * so the beat is in flight for exactly as long as the test needs while the
 * control plane's side has already settled — the shape of a response that
 * lands after the enrollment it belongs to is over. Nothing here waits on a
 * clock.
 */
function heldAnswers() {
  const pending: Array<{ release: () => void; reject: (error: unknown) => void }> = []
  let holding = false
  return {
    pending,
    hold: () => {
      holding = true
    },
    wrap: (transport: MachineTransport): MachineTransport => ({
      ...transport,
      heartbeat: async (input) => {
        const answer = await transport.heartbeat(input)
        if (!holding) return answer
        await new Promise<void>((resolve, reject) => pending.push({ release: resolve, reject }))
        return answer
      },
    }),
  }
}

describe("start", () => {
  test("a transport failure on acquire stops the connector without a timer, and never escapes as a rejection", async () => {
    // Every start failure is one stopped state rather than two shapes: a
    // rejection here would surface as unhandled on Electron startup, and a
    // timer installed anyway would beat against a generation never claimed.
    const h = await machineHost({
      wrap: (transport) => ({
        ...transport,
        acquire: async () => {
          throw new Error("control plane unreachable")
        },
      }),
    })

    const state = await h.connector.start()

    expect(state).toMatchObject({ status: "stopped", reason: "error", detail: expect.stringContaining("control plane unreachable") })
    expect(h.errors.map((entry) => entry.stage)).toEqual(["acquire"])
    expect(h.ticks).toEqual([])
    expect(h.beats()).toEqual([])
  })
})

describe("heartbeat", () => {
  test("extends the lease on each timer tick", async () => {
    const h = await machineHost()
    await h.connector.start()
    const issued = h.clock.now

    h.clock.now += 10_000
    h.tick()
    await vi.waitFor(() => expect(h.beats()).toHaveLength(2))

    expect(h.connector.state()).toMatchObject({ status: "enrolled", enrollment: { expires_at: issued + 10_000 + LEASE_MS } })
  })

  test("tells a listener about the renewed lease on every tick, not just an explicit beat()", async () => {
    // A timer-driven tick has no caller waiting on its result; `state()`
    // holds the answer, but nothing across a process boundary polls it. The
    // desktop's Host Connector child forwards exactly this to the parent.
    const h = await machineHost()
    await h.connector.start()
    expect(h.renewals).toHaveLength(1)

    h.clock.now += 10_000
    h.tick()
    await vi.waitFor(() => expect(h.renewals).toHaveLength(2))

    expect(h.renewals[1]).toMatchObject({ enrollment_id: h.enrollmentId, expires_at: h.clock.now + LEASE_MS })
  })

  test("does not tell a listener about a lease that was not renewed", async () => {
    // A disruption and a decision both leave the lease where it was; a
    // listener told about either would show an extension that never happened.
    const h = await machineHost()
    await h.connector.start()
    expect(h.renewals).toHaveLength(1)

    h.cp.faults.unavailable = 503
    await h.connector.beat()
    h.cp.faults.unavailable = undefined
    h.cp.revoke(h.enrollmentId)
    await h.connector.beat()

    expect(h.renewals).toHaveLength(1)
    expect(h.connector.state()).toMatchObject({ status: "stopped", reason: "revoked" })
  })

  test("stops on a decision instead of acquiring again", async () => {
    // A refused beat means the control plane no longer recognises this
    // machine. Claiming a new generation would be the connector overruling a
    // revocation, and a connector that reconnects through one looks exactly
    // like a working one on a status screen.
    const h = await machineHost()
    await h.connector.start()
    h.cp.revoke(h.enrollmentId)

    const state = await h.connector.beat()

    expect(state).toMatchObject({ status: "stopped", reason: "revoked", detail: expect.stringContaining("enrollment_revoked") })
    expect(h.errors.map((entry) => entry.stage)).toEqual(["heartbeat"])
    expect(h.acquires()).toHaveLength(1)
  })

  test("a paused enrollment is a decision too", async () => {
    const h = await machineHost()
    await h.connector.start()
    h.cp.pause(h.enrollmentId, true)

    expect(await h.connector.beat()).toMatchObject({ status: "stopped", reason: "revoked", detail: expect.stringContaining("enrollment_paused") })
  })

  /**
   * Deploying the control plane makes it answer
   * `503 deployment_candidate_unavailable` for the seconds between the upload
   * and the release phase opening. A beat in that window that stopped the
   * machine put `revoked` on the panel while the laptop went on reporting
   * `serving: true` with open relay sockets: the same symptom as a real
   * revocation, none of the same cause.
   */
  test("survives a control plane that is briefly unavailable, and beats again", async () => {
    const h = await machineHost()
    await h.connector.start()
    const leased = h.connector.state()

    h.cp.faults.unavailable = 503
    expect(await h.connector.beat(), "a disruption is not a decision").toEqual(leased)
    expect(h.errors.map((entry) => entry.stage)).toEqual(["heartbeat"])

    h.cp.faults.unavailable = undefined
    h.clock.now += 10_000
    expect(await h.connector.beat()).toMatchObject({ status: "enrolled", enrollment: { expires_at: h.clock.now + LEASE_MS } })
    expect(h.acquires(), "recovering must not claim a new generation behind the user").toHaveLength(1)
  })

  test("a transport failure with no status is a disruption, not a revocation", async () => {
    // A socket that never opened says nothing about the enrollment. The
    // control plane's own lease is what stops routing if the machine is
    // really gone.
    let failures = 1
    const h = await machineHost({
      wrap: (transport) => ({
        ...transport,
        heartbeat: async (input) => {
          if (failures-- > 0) throw new TypeError("fetch failed")
          return transport.heartbeat(input)
        },
      }),
    })
    await h.connector.start()

    expect(await h.connector.beat()).toMatchObject({ status: "enrolled" })
    expect(await h.connector.beat()).toMatchObject({ status: "enrolled" })
    expect(h.beats()).toHaveLength(2)
  })

  test("cancels the timer when it stops", async () => {
    // Otherwise a stopped connector keeps waking to do nothing, forever.
    const h = await machineHost()
    await h.connector.start()
    h.cp.revoke(h.enrollmentId)

    await h.connector.beat()

    expect(h.cancels.count).toBe(1)
  })

  test("starting again does not leave the previous loop running", async () => {
    // A second `start` on a live connector installs a second interval; the
    // handle for the first must be cancelled, not overwritten, or nothing
    // holds it and `close()` cannot stop it. The desktop guards against
    // calling `start` twice; a headless connector is on its own.
    const h = await machineHost()
    await h.connector.start()

    await h.connector.start()

    expect(h.connector.generation()).toBe(2)
    expect(h.ticks).toHaveLength(2)
    expect(h.cancels.count).toBe(1)
    h.connector.close()
    expect(h.cancels.count).toBe(2)
  })

  test("does nothing once stopped", async () => {
    const h = await machineHost()
    await h.connector.start()
    h.connector.close()

    await h.connector.beat()
    h.tick()
    await h.connector.beat()

    expect(h.beats()).toHaveLength(1)
  })
})

describe("a beat still in flight when its era ends", () => {
  /**
   * A beat outlives its era when the control plane answers slowly and, in
   * the meantime, the user closes the connector or the process restarts it:
   * `beat()` exists to be forced after a wake from sleep while the pre-sleep
   * request is still hanging off a socket that died with the lid.
   */
  test("a late success cannot reverse a revocation", async () => {
    const gate = heldAnswers()
    const h = await machineHost({ wrap: gate.wrap })
    await h.connector.start()
    gate.hold()

    const early = h.connector.beat()
    // The overlap, proved: the request is answered and unreleased. If this
    // ever reads zero entries, the assertions below are measuring nothing.
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))

    // The control plane revokes the machine and a restart learns of it first.
    h.cp.revoke(h.enrollmentId)
    expect(await h.connector.start()).toMatchObject({ status: "stopped", reason: "revoked" })

    // Now the older request finally answers, successfully. It was issued
    // against a generation the control plane has since refused.
    gate.pending[0]?.release()
    await early

    expect(h.connector.state()).toMatchObject({ status: "stopped", reason: "revoked", detail: expect.stringContaining("enrollment_revoked") })
    expect(h.renewals).toHaveLength(1)
  })

  test("a late success does not resurrect a connector the user closed", async () => {
    // Asserted as the WHOLE state: `stopped` carries no `enrollment`, so a
    // resurrection that spread `state.enrollment` after the await would
    // produce an enrollment with an expiry, no id and no host — a machine the
    // panel shows as published and the control plane has never heard of.
    const gate = heldAnswers()
    const h = await machineHost({ wrap: gate.wrap })
    await h.connector.start()
    gate.hold()

    const inFlight = h.connector.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    h.connector.close()

    gate.pending[0]?.release()
    await inFlight

    expect(h.connector.state()).toEqual({ status: "stopped", reason: "closed", detail: "connector closed" })
    expect(h.renewals).toHaveLength(1)
  })

  test("a late rejection does not relabel a close as a revocation", async () => {
    // The user turned remote access off, and a request that was already open
    // came back refused — which it would, since the generation is being let
    // go. Telling them their access was taken away is a false alarm about the
    // one event this panel exists to report honestly.
    const gate = heldAnswers()
    const h = await machineHost({ wrap: gate.wrap })
    await h.connector.start()
    gate.hold()

    const inFlight = h.connector.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    h.connector.close()

    gate.pending[0]?.reject(new Error('HOSTED_HTTP 404 {"error":{"code":"host_enrollment_not_found"}}'))
    await inFlight

    expect(h.connector.state()).toMatchObject({ status: "stopped", reason: "closed" })
    expect(h.errors, "nothing went wrong, so nothing is reported").toEqual([])
  })

  /**
   * A restart claims the next generation while the older beat is still out.
   * Its answer describes the generation the acquire just superseded, so it is
   * dropped; the restart's own first beat — queued behind it — is what renews
   * the lease. Asserted between the two landings, where the difference is
   * visible.
   */
  for (const closedFirst of [false, true]) {
    test(`a beat from before a restart${closedFirst ? " through close()" : ""} cannot write onto the generation that replaced it`, async () => {
      const gate = heldAnswers()
      const h = await machineHost({ wrap: gate.wrap })
      await h.connector.start()
      gate.hold()

      const stale = h.connector.beat()
      await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
      if (closedFirst) h.connector.close()
      h.clock.now += 10_000
      const restarting = h.connector.start()
      await vi.waitFor(() => expect(h.connector.generation()).toBe(2))
      expect(h.connector.state()).toMatchObject({ status: "enrolled", enrollment: { expires_at: 0 } })

      gate.pending[0]?.release()
      await stale

      expect(h.connector.state(), "the stale answer wrote nothing").toMatchObject({ status: "enrolled", enrollment: { expires_at: 0 } })
      expect(h.renewals).toHaveLength(1)

      await vi.waitFor(() => expect(gate.pending).toHaveLength(2))
      gate.pending[1]?.release()
      await restarting

      expect(h.connector.state()).toMatchObject({ status: "enrolled", enrollment: { expires_at: h.clock.now + LEASE_MS } })
      expect(h.renewals).toHaveLength(2)
    })
  }

  test("the timer stays cancelled after a late success", async () => {
    // A reversal would leave a connector reporting `enrolled` with no timer:
    // it can never beat again, so the lease it claims lapses silently while
    // the panel keeps saying the machine is published.
    const gate = heldAnswers()
    const h = await machineHost({ wrap: gate.wrap })
    await h.connector.start()
    gate.hold()

    const inFlight = h.connector.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    h.connector.close()
    gate.pending[0]?.release()
    await inFlight

    expect(h.cancels.count).toBe(1)
    expect(h.connector.state().status).toBe("stopped")
  })
})

describe("close", () => {
  test("reports closed, not revoked", async () => {
    // The distinction the user sees: "you turned this off" versus "your access
    // was taken away".
    const h = await machineHost()
    await h.connector.start()

    h.connector.close()

    expect(h.connector.state()).toMatchObject({ status: "stopped", reason: "closed" })
  })

  test("does not overwrite an earlier revocation", async () => {
    const h = await machineHost()
    await h.connector.start()
    h.cp.revoke(h.enrollmentId)
    await h.connector.beat()

    h.connector.close()

    expect(h.connector.state()).toMatchObject({ reason: "revoked" })
    expect(h.cancels.count).toBe(1)
  })
})

describe("host identity", () => {
  test("signatures verify against the exported public key", async () => {
    const keys = await createHostKeyPair()
    const payload = enrollmentPayload({ hostId: "host_laptop", requestId: "req_1", nonce: "nonce_1" })

    const signature = await keys.sign(payload)
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)),
      new TextEncoder().encode(payload),
    )

    expect(verified).toBe(true)
  })

  test("a restored identity produces the same public key", async () => {
    // Restarting the connector must not look like a different machine, or
    // every restart would need a fresh enrollment.
    const original = await createHostKeyPair()

    const restored = await hostKeyPairFromJwk(original.privateKeyJwk)

    expect(JSON.parse(restored.publicKey).x).toBe(JSON.parse(original.publicKey).x)
    expect(JSON.parse(restored.publicKey).y).toBe(JSON.parse(original.publicKey).y)
    expect(JSON.parse(restored.publicKey)).not.toHaveProperty("d")
  })

  test("the enrollment payload matches the authority's verifier byte for byte", () => {
    // Duplicated definitions drift. When they do, the symptom is "enrollment
    // rejects every signature", which reads as a crypto bug rather than a
    // string mismatch. Both sides assert this literal.
    expect(enrollmentPayload({ hostId: "h", requestId: "r", nonce: "n" })).toBe(
      "claxedo.host-enrollment.enroll.v1\nhost_id=h\nrequest_id=r\nnonce=n",
    )
  })
})

describe("declared session composition", () => {
  test("carries the injected composition on every beat, for either flavour", async () => {
    // The connector does not know how the daemon composed its runtimes and
    // must not guess: the control plane mints each client's event-stream scope
    // from this declaration. Both flavours, because a beat that hard-coded one
    // would still satisfy a single-value test.
    for (const declared of ["local", "managed-private"] as const) {
      const h = await machineHost({ sessionAuthority: declared })
      await h.connector.start()
      await h.connector.beat()
      await h.connector.beat()

      expect(h.beats()).toHaveLength(3)
      for (const beat of h.beats()) expect(beat.body.sessionAuthority).toBe(declared)
    }
  })

  test("says nothing when nothing was injected, rather than picking a flavour", async () => {
    // A connector whose parent could not read the daemon's composition
    // publishes an UNDECLARED machine. The control plane records the absence
    // and mints no scope — a default here would put every client of this
    // machine on the wrong stream.
    const h = await machineHost()
    await h.connector.start()
    await h.connector.beat()

    expect(h.beats()).toHaveLength(2)
    for (const beat of h.beats()) expect(beat.body).not.toHaveProperty("sessionAuthority")
  })
})
