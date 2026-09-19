import { describe, expect, test } from "bun:test"

import { parseHostConnectorChildMessage } from "./child-protocol"

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

  test("refuses a credential that is neither a record nor an explicit withdrawal", () => {
    expect(parseHostConnectorChildMessage({ type: "serving", tunnel: "htt.1" })).toBeUndefined()
    expect(parseHostConnectorChildMessage({ type: "serving" })).toBeUndefined()
  })
})
