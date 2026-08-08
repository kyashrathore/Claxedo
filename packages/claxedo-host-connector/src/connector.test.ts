import { describe, expect, test, vi } from "vitest"
import { createHostConnector, type ConnectorTransport } from "./connector"
import { createHostKeyPair, enrollmentPayload, heartbeatPayload, hostKeyPairFromJwk } from "./host-identity"

/**
 * The connector's protocol, and the contract it shares with the authority.
 *
 * The payload tests matter more than they look. The connector duplicates the
 * payload builders rather than importing server code, so the two definitions
 * can drift — and a drift would show up as "enrollment mysteriously rejects
 * every signature". The literal strings are asserted on both sides.
 */

const HOST_ID = "host_laptop"

function transport(overrides: Partial<ConnectorTransport> = {}) {
  const calls = { requests: 0, enrolls: [] as unknown[], beats: [] as unknown[] }
  const base: ConnectorTransport = {
    createRequest: async () => {
      calls.requests++
      return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
    },
    enroll: async (input) => {
      calls.enrolls.push(input)
      return { enrollment_id: "enr_1", host_id: HOST_ID, expires_at: 1_000 }
    },
    heartbeat: async (input) => {
      calls.beats.push(input)
      return { expires_at: 2_000 }
    },
    ...overrides,
  }
  return { transport: base, calls }
}

async function connector(
  overrides: Partial<ConnectorTransport> = {},
  onError?: (stage: "enroll" | "heartbeat", error: unknown) => void,
) {
  const t = transport(overrides)
  let tick: (() => void) | undefined
  const ticks: Array<() => void> = []
  const cancels = { count: 0 }
  const instance = createHostConnector({
    hostId: HOST_ID,
    displayName: "Work laptop",
    keys: await createHostKeyPair(),
    transport: t.transport,
    heartbeatIntervalMs: 30_000,
    ...(onError ? { onError } : {}),
    setInterval: (fn) => {
      tick = fn
      ticks.push(fn)
      return {
        cancel: () => {
          cancels.count++
        },
      }
    },
  })
  return { instance, calls: t.calls, tick: () => tick?.(), ticks, cancels }
}

describe("start", () => {
  test("enrolls with a signature over the issued nonce", async () => {
    const { instance, calls } = await connector()

    const state = await instance.start()

    expect(state).toMatchObject({ status: "enrolled", enrollment: { host_id: HOST_ID } })
    expect(calls.enrolls).toHaveLength(1)
    expect(calls.enrolls[0]).toMatchObject({ hostId: HOST_ID, requestId: "req_1", displayName: "Work laptop" })
  })

  test("never sends the private key", async () => {
    // The whole premise: the control plane stores a public key and verifies
    // signatures. A private JWK crossing this boundary would end that.
    const { instance, calls } = await connector()
    await instance.start()

    const sent = JSON.stringify(calls.enrolls[0])
    expect(sent).toContain("publicKey")
    // A P-256 private JWK is exactly the public one plus `d`.
    expect(JSON.parse(JSON.parse(sent).publicKey)).not.toHaveProperty("d")
  })

  test("stops without starting a heartbeat when enrollment fails", async () => {
    // Beating against an enrollment that does not exist is noise the control
    // plane has to reject on every tick.
    const { instance, calls, tick } = await connector({
      enroll: async () => {
        throw new Error("rejected")
      },
    })

    const state = await instance.start()

    expect(state).toMatchObject({ status: "stopped", reason: "error" })
    tick()
    expect(calls.beats).toEqual([])
  })
})

describe("heartbeat", () => {
  test("extends the enrollment on each tick", async () => {
    const { instance, calls, tick } = await connector()
    await instance.start()

    tick()
    await vi.waitFor(() => expect(calls.beats).toHaveLength(1))
    expect(instance.state()).toMatchObject({ status: "enrolled", enrollment: { expires_at: 2_000 } })
  })

  test("stops on rejection instead of re-enrolling", async () => {
    // A rejected heartbeat means the control plane no longer recognises this
    // machine. Re-enrolling would be the connector overruling a revocation,
    // and a connector that reconnects through one looks exactly like a working
    // one on a status screen.
    const { instance, calls } = await connector({
      heartbeat: async () => {
        throw new Error("revoked")
      },
    })
    await instance.start()

    const state = await instance.beat()

    expect(state).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(calls.requests).toBe(1)
    expect(calls.enrolls).toHaveLength(1)
  })

  test("cancels the timer when it stops", async () => {
    // Otherwise a stopped connector keeps waking to do nothing, forever.
    const { instance, cancels } = await connector({
      heartbeat: async () => {
        throw new Error("revoked")
      },
    })
    await instance.start()

    await instance.beat()

    expect(cancels.count).toBe(1)
  })

  test("starting again does not leave the previous loop running", async () => {
    // A second `start` on a live connector installs a second interval. Before
    // this, the handle for the first one was simply overwritten — nothing held
    // it, so `close()` could not cancel it and it woke forever. The desktop
    // guards against calling `start` twice; a headless connector is on its own.
    const { instance, ticks, cancels } = await connector()
    await instance.start()

    await instance.start()

    expect(ticks).toHaveLength(2)
    expect(cancels.count).toBe(1)
    instance.close()
    expect(cancels.count).toBe(2)
  })

  test("does nothing once stopped", async () => {
    const { instance, calls } = await connector()
    await instance.start()
    instance.close()

    await instance.beat()

    expect(calls.beats).toEqual([])
  })
})

/**
 * A heartbeat the test answers by hand.
 *
 * Every assertion below depends on two beats being genuinely in flight at the
 * same moment, so the responses cannot be produced by the transport — the test
 * has to hold them open, and prove it is holding them, before it resolves
 * either one. Nothing here waits on a clock.
 */
function gatedHeartbeat() {
  const pending: Array<{ resolve: (expiresAt: number) => void; reject: (error: unknown) => void }> = []
  return {
    pending,
    heartbeat: () =>
      new Promise<{ expires_at: number }>((resolve, reject) => {
        pending.push({ resolve: (expires_at) => resolve({ expires_at }), reject })
      }),
  }
}

describe("overlapping heartbeats", () => {
  /**
   * Two beats overlap in production for two ordinary reasons: a beat that takes
   * longer than the 20s interval, and the forced beat `beat()` exists for —
   * "after a wake from sleep", fired while the pre-sleep request is still
   * hanging off a socket that died with the lid.
   */
  test("a late success cannot reverse a revocation", async () => {
    const gate = gatedHeartbeat()
    const { instance } = await connector({ heartbeat: gate.heartbeat })
    await instance.start()

    // Issued one at a time so `pending` is in a KNOWN order. Both beats send
    // the same bytes, so a test that fired them together could not say which
    // entry belonged to which promise, and would settle the wrong one roughly
    // half the time — a coin flip in a suite that runs with `retries: 0`.
    const early = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    const late = instance.beat()
    // The overlap, proved: two requests are open and neither has answered. If
    // this ever reads one entry, the assertions below are measuring nothing.
    await vi.waitFor(() => expect(gate.pending).toHaveLength(2))

    // The second beat comes back first, rejected: the control plane no longer
    // recognises this machine.
    gate.pending[1]!.reject(new Error("403 revoked"))
    await late
    expect(instance.state()).toMatchObject({ status: "stopped", reason: "revoked" })

    // Now the older request finally answers, successfully. It was issued
    // against an enrollment that no longer exists.
    gate.pending[0]!.resolve(2_000)
    await early

    expect(instance.state()).toMatchObject({ status: "stopped", reason: "revoked" })
  })

  test("a late success does not resurrect a connector the user closed", async () => {
    // Asserted as the WHOLE state rather than a subset: the resurrection did
    // not merely re-enter `enrolled`, it entered it with nothing. `stopped`
    // carries no `enrollment`, so spreading `state.enrollment` after the await
    // spread `undefined` and produced an enrollment with an expiry, no id and
    // no host — a machine the panel shows as published and the control plane
    // has never heard of.
    const gate = gatedHeartbeat()
    const { instance } = await connector({ heartbeat: gate.heartbeat })
    await instance.start()

    const inFlight = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    instance.close()

    gate.pending[0]!.resolve(2_000)
    await inFlight

    expect(instance.state()).toEqual({ status: "stopped", reason: "closed", detail: "connector closed" })
  })

  test("a late rejection does not relabel a pause as a revocation", async () => {
    // The distinction `close` exists to preserve, in the other direction: the
    // user paused, and a request that was already open came back rejected —
    // which it would, since the enrollment is being allowed to lapse. Telling
    // them their access was taken away is a false alarm about the one event
    // this panel exists to report honestly.
    const gate = gatedHeartbeat()
    const errors: Array<{ stage: string }> = []
    const { instance } = await connector({ heartbeat: gate.heartbeat }, (stage) => errors.push({ stage }))
    await instance.start()

    const inFlight = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    instance.close()

    gate.pending[0]!.reject(new Error("404 unknown enrollment"))
    await inFlight

    expect(instance.state()).toMatchObject({ status: "stopped", reason: "closed" })
    // And it is not reported as an error either: nothing went wrong.
    expect(errors).toEqual([])
  })

  /** A connector whose enrollments are numbered, so a stale one is nameable. */
  async function numberedEnrollments(gate: ReturnType<typeof gatedHeartbeat>) {
    const enrollments = { count: 0 }
    return await connector({
      heartbeat: gate.heartbeat,
      enroll: async () => {
        enrollments.count++
        return { enrollment_id: `enr_${enrollments.count}`, host_id: HOST_ID, expires_at: 1_000 }
      },
    })
  }

  test("a beat from before a pause cannot write onto the enrollment that replaced it", async () => {
    // Pause and resume, with a request left over from before the pause. The
    // stale answer describes an enrollment that no longer exists; adopting it
    // would put the dead enrollment's record back on a live machine.
    const gate = gatedHeartbeat()
    const { instance } = await numberedEnrollments(gate)
    await instance.start()

    const stale = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    instance.close()
    await instance.start()
    expect(instance.state()).toMatchObject({ enrollment: { enrollment_id: "enr_2" } })

    gate.pending[0]!.resolve(2_000)
    await stale

    expect(instance.state()).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: "enr_2" } })
  })

  test("a beat from before a re-enrollment cannot write onto the one that replaced it", async () => {
    // The same staleness without a pause to mark the boundary: `start` called
    // on a connector that is already enrolled. Nothing passed through `stop`,
    // so the enrollment itself has to be what moves the era on.
    const gate = gatedHeartbeat()
    const { instance } = await numberedEnrollments(gate)
    await instance.start()

    const stale = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    await instance.start()
    expect(instance.state()).toMatchObject({ enrollment: { enrollment_id: "enr_2" } })

    gate.pending[0]!.resolve(2_000)
    await stale

    expect(instance.state()).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: "enr_2" } })
  })

  test("the timer stays cancelled after a late success", async () => {
    // The reversal left a connector reporting `enrolled` with no timer: it can
    // never beat again, so the enrollment it claims lapses silently while the
    // panel keeps saying the machine is published.
    const gate = gatedHeartbeat()
    const { instance, cancels } = await connector({ heartbeat: gate.heartbeat })
    await instance.start()

    const inFlight = instance.beat()
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1))
    instance.close()
    gate.pending[0]!.resolve(2_000)
    await inFlight

    expect(cancels.count).toBe(1)
    expect(instance.state().status).toBe("stopped")
  })
})

describe("close", () => {
  test("reports closed, not revoked", async () => {
    // The distinction the user sees: "you turned this off" versus "your access
    // was taken away".
    const { instance } = await connector()
    await instance.start()

    instance.close()

    expect(instance.state()).toMatchObject({ status: "stopped", reason: "closed" })
  })

  test("does not overwrite an earlier revocation", async () => {
    const { instance } = await connector({
      heartbeat: async () => {
        throw new Error("revoked")
      },
    })
    await instance.start()
    await instance.beat()

    instance.close()

    expect(instance.state()).toMatchObject({ reason: "revoked" })
  })
})

describe("host identity", () => {
  test("signatures verify against the exported public key", async () => {
    const keys = await createHostKeyPair()
    const payload = enrollmentPayload({ hostId: HOST_ID, requestId: "req_1", nonce: "nonce_1" })

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

  test("payloads match the authority's verifiers byte for byte", async () => {
    // Duplicated definitions drift. When they do, the symptom is "enrollment
    // rejects every signature", which reads as a crypto bug rather than a
    // string mismatch. Both sides assert these literals.
    expect(enrollmentPayload({ hostId: "h", requestId: "r", nonce: "n" })).toBe(
      "claxedo.host-enrollment.enroll.v1\nhost_id=h\nrequest_id=r\nnonce=n",
    )
    expect(heartbeatPayload({ hostId: "h" })).toBe("claxedo.host-enrollment.heartbeat.v1\nhost_id=h\nttl_ms=")
    expect(heartbeatPayload({ hostId: "h", ttlMs: 60_000 })).toBe(
      "claxedo.host-enrollment.heartbeat.v1\nhost_id=h\nttl_ms=60000",
    )
  })
})

describe("a control-plane failure before enrollment", () => {
  test("stops rather than escaping as a rejection", async () => {
    // `createRequest` is a network call. It used to sit outside the try, so it
    // rejected while every other enrollment failure returned a stopped state —
    // two shapes for one outcome, and on Electron startup the rejecting one is
    // unhandled.
    const { instance, calls } = await connector({
      createRequest: async () => {
        throw new Error("control plane unreachable")
      },
    })

    const state = await instance.start()

    expect(state).toMatchObject({ status: "stopped", reason: "error" })
    expect(String((state as { detail: string }).detail)).toContain("control plane unreachable")
    expect(calls.enrolls).toEqual([])
  })

  test("does not start a heartbeat after that failure", async () => {
    // Beating against an enrollment that was never requested is noise the
    // control plane has to reject on every tick.
    const { instance, calls, tick } = await connector({
      createRequest: async () => {
        throw new Error("offline")
      },
    })
    await instance.start()

    tick()

    expect(calls.beats).toEqual([])
  })
})
