import { describe, expect, test } from "bun:test"

import { parseHostConnectorChildMessage, parseHostConnectorParentMessage } from "./child-protocol"

const JWKS = "https://relay.test/.well-known/jwks.json"
const AUTHORITY = "https://control-plane.test/api/runtime-authority/session-authorize"

describe("the serving message", () => {
  test("carries both addresses beside the credential", () => {
    expect(
      parseHostConnectorChildMessage({
        type: "serving",
        tunnel: { hostTunnelToken: "htt.1" },
        endpoints: { relayJwksUrl: JWKS, sessionAuthorityUrl: AUTHORITY },
      }),
    ).toEqual({
      type: "serving",
      tunnel: { hostTunnelToken: "htt.1" },
      endpoints: { relayJwksUrl: JWKS, sessionAuthorityUrl: AUTHORITY },
    })
  })

  test("carries the addresses of a control plane that names only one", () => {
    expect(
      parseHostConnectorChildMessage({ type: "serving", tunnel: null, endpoints: { relayJwksUrl: JWKS } }),
    ).toEqual({ type: "serving", tunnel: null, endpoints: { relayJwksUrl: JWKS } })
  })

  test("still carries them when the ack withdraws the credential", () => {
    // The daemon is told to stop serving and told what it was serving under in
    // the same message; the route keys its endpoints off the credential.
    expect(
      parseHostConnectorChildMessage({
        type: "serving",
        tunnel: null,
        endpoints: { sessionAuthorityUrl: AUTHORITY },
      }),
    ).toEqual({ type: "serving", tunnel: null, endpoints: { sessionAuthorityUrl: AUTHORITY } })
  })

  test("names no endpoints when the ack named none", () => {
    const parsed = parseHostConnectorChildMessage({ type: "serving", tunnel: { hostTunnelToken: "htt.1" } })

    expect(parsed).toEqual({ type: "serving", tunnel: { hostTunnelToken: "htt.1" } })
    expect(parsed).not.toHaveProperty("endpoints")
  })

  test("drops what the daemon's strict body would refuse", () => {
    // The serving route parses `endpoints` with a strict schema, so a third
    // key reaching it would fail the whole PUT — credential included.
    expect(
      parseHostConnectorChildMessage({
        type: "serving",
        tunnel: null,
        endpoints: { relayJwksUrl: JWKS, relayUrl: "https://relay.test" },
      }),
    ).toEqual({ type: "serving", tunnel: null, endpoints: { relayJwksUrl: JWKS } })
  })

  test("refuses the whole message when an address is unreadable", () => {
    // Forwarding the credential without them would open a tunnel that answers
    // 503 to every relayed read, which is indistinguishable from a working one.
    for (const endpoints of [
      { relayJwksUrl: 7 },
      { relayJwksUrl: "" },
      { sessionAuthorityUrl: null },
      { relayJwksUrl: JWKS, sessionAuthorityUrl: 7 },
      {},
      "https://relay.test",
    ]) {
      expect(parseHostConnectorChildMessage({ type: "serving", tunnel: null, endpoints })).toBeUndefined()
    }
  })

  /**
   * The credential crosses this boundary as the control plane wrote it. The
   * daemon reads the machine's own enrollment out of it and declares it to
   * every local client, so a codec that narrowed the credential to the fields
   * main happens to name would strip an identity main never looks at.
   */
  test("carries the credential's fields main never reads, the enrollment among them", () => {
    const tunnel = {
      hostTunnelToken: "htt.1",
      tokenExpiresAt: 1_788_255_486_000,
      jti: "jti-1",
      hostId: "host_1",
      enrollmentId: "enr_this_machine",
      workspaceIds: ["ws_1"],
      relayUrl: "https://relay.test",
    }

    expect(parseHostConnectorChildMessage({ type: "serving", tunnel })).toEqual({ type: "serving", tunnel })
  })

  test("refuses a credential that is neither a record nor an explicit withdrawal", () => {
    expect(parseHostConnectorChildMessage({ type: "serving", tunnel: "htt.1" })).toBeUndefined()
    expect(parseHostConnectorChildMessage({ type: "serving" })).toBeUndefined()
  })
})

const PRIVATE_JWK = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }

describe("the sealing-key messages", () => {
  test("the child's minted key and the parent's store answer round-trip", () => {
    expect(
      parseHostConnectorChildMessage({ type: "sealing-key-created", requestId: "r1", sealingPrivateKeyJwk: PRIVATE_JWK }),
    ).toEqual({ type: "sealing-key-created", requestId: "r1", sealingPrivateKeyJwk: PRIVATE_JWK })
    expect(parseHostConnectorParentMessage({ type: "sealing-key-stored", requestId: "r1" })).toEqual({
      type: "sealing-key-stored",
      requestId: "r1",
    })
  })

  test("a key that is not a JWK is refused", () => {
    expect(parseHostConnectorChildMessage({ type: "sealing-key-created", requestId: "r1", sealingPrivateKeyJwk: "d" })).toBeUndefined()
    expect(parseHostConnectorChildMessage({ type: "sealing-key-created", requestId: "r1" })).toBeUndefined()
  })

  test("the identity carries the sealing half beside the enrollment key", () => {
    const identity = { hostId: "host_1", privateKeyJwk: PRIVATE_JWK, sealingPrivateKeyJwk: PRIVATE_JWK }
    expect(parseHostConnectorChildMessage({ type: "identity-created", requestId: "r1", identity })).toEqual({
      type: "identity-created",
      requestId: "r1",
      identity,
    })
    expect(
      parseHostConnectorParentMessage({
        type: "bootstrap",
        requestId: "b1",
        controlPlaneUrl: "https://cp.test",
        heartbeatIntervalMs: 1,
        identity,
      }),
    ).toMatchObject({ identity })
    // Absent is a record from before machines could receive secrets; a
    // present non-key is a malformed record, and the message goes with it.
    const { sealingPrivateKeyJwk: _absent, ...older } = identity
    expect(parseHostConnectorChildMessage({ type: "identity-created", requestId: "r1", identity: older })).toEqual({
      type: "identity-created",
      requestId: "r1",
      identity: older,
    })
    expect(
      parseHostConnectorChildMessage({
        type: "identity-created",
        requestId: "r1",
        identity: { ...identity, sealingPrivateKeyJwk: "not a key" },
      }),
    ).toBeUndefined()
  })
})

describe("the provider-config messages", () => {
  test("the sealed revision, the store answer and the opened revision round-trip", () => {
    expect(
      parseHostConnectorChildMessage({ type: "provider-config", requestId: "p1", revision: 3, sealed: "mseal1.a.b.c" }),
    ).toEqual({ type: "provider-config", requestId: "p1", revision: 3, sealed: "mseal1.a.b.c" })
    expect(parseHostConnectorChildMessage({ type: "provider-config", requestId: "p1", revision: 4, sealed: null })).toEqual({
      type: "provider-config",
      requestId: "p1",
      revision: 4,
      sealed: null,
    })
    expect(parseHostConnectorParentMessage({ type: "provider-config-stored", requestId: "p1", ok: true })).toEqual({
      type: "provider-config-stored",
      requestId: "p1",
      ok: true,
    })
    expect(
      parseHostConnectorParentMessage({ type: "provider-config-stored", requestId: "p1", ok: false, error: "disk full" }),
    ).toEqual({ type: "provider-config-stored", requestId: "p1", ok: false, error: "disk full" })
    expect(parseHostConnectorParentMessage({ type: "provider-config-stored", requestId: "p1", ok: false })).toBeUndefined()
    expect(
      parseHostConnectorChildMessage({ type: "provider-config-ready", revision: 3, providers: '{"version":1,"providers":{}}' }),
    ).toEqual({ type: "provider-config-ready", revision: 3, providers: '{"version":1,"providers":{}}' })
  })

  test("a sealed value that is neither text nor the explicit withdrawal refuses the whole message", () => {
    // A missing blob forwarded as a withdrawal would empty the daemon's
    // credentials on a malformed delivery.
    for (const sealed of [undefined, 7, {}, ["mseal1"], true]) {
      expect(parseHostConnectorChildMessage({ type: "provider-config", requestId: "p1", revision: 3, sealed })).toBeUndefined()
    }
    for (const revision of [-1, 1.5, "3", undefined]) {
      expect(parseHostConnectorChildMessage({ type: "provider-config", requestId: "p1", revision, sealed: null })).toBeUndefined()
      expect(parseHostConnectorChildMessage({ type: "provider-config-ready", revision, providers: "{}" })).toBeUndefined()
    }
    expect(parseHostConnectorChildMessage({ type: "provider-config-ready", revision: 3, providers: { version: 1 } })).toBeUndefined()
  })

  test("a stage the child recovered from crosses as its own message, named and with a reason", () => {
    expect(parseHostConnectorChildMessage({ type: "child-error", stage: "provider-config", detail: "DataError" })).toEqual({
      type: "child-error",
      stage: "provider-config",
      detail: "DataError",
    })
    expect(parseHostConnectorChildMessage({ type: "child-error", stage: "provider-config", detail: "" })).toEqual({
      type: "child-error",
      stage: "provider-config",
      detail: "",
    })
    for (const bad of [{ stage: "", detail: "d" }, { stage: "s" }, { stage: 7, detail: "d" }, { stage: "s", detail: 7 }]) {
      expect(parseHostConnectorChildMessage({ type: "child-error", ...bad })).toBeUndefined()
    }
  })

  test("the bootstrap carries the revision main restored, and refuses a malformed one", () => {
    const bootstrap = { type: "bootstrap", requestId: "b1", controlPlaneUrl: "https://cp.test", heartbeatIntervalMs: 1 }
    expect(parseHostConnectorParentMessage({ ...bootstrap, providerConfig: { revision: 2, sealed: "mseal1.a.b.c" } })).toMatchObject({
      providerConfig: { revision: 2, sealed: "mseal1.a.b.c" },
    })
    expect(parseHostConnectorParentMessage(bootstrap)).not.toHaveProperty("providerConfig")
    expect(parseHostConnectorParentMessage({ ...bootstrap, providerConfig: { revision: 2 } })).toBeUndefined()
  })
})
