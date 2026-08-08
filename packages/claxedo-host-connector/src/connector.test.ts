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

async function connector(overrides: Partial<ConnectorTransport> = {}) {
  const t = transport(overrides)
  let tick: (() => void) | undefined
  const cancels = { count: 0 }
  const instance = createHostConnector({
    hostId: HOST_ID,
    displayName: "Work laptop",
    keys: await createHostKeyPair(),
    transport: t.transport,
    heartbeatIntervalMs: 30_000,
    setInterval: (fn) => {
      tick = fn
      return {
        cancel: () => {
          cancels.count++
        },
      }
    },
  })
  return { instance, calls: t.calls, tick: () => tick?.(), cancels }
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

  test("does nothing once stopped", async () => {
    const { instance, calls } = await connector()
    await instance.start()
    instance.close()

    await instance.beat()

    expect(calls.beats).toEqual([])
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
