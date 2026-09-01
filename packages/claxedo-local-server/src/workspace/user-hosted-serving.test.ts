import { describe, expect, test } from "vitest"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

import { loopbackReplayHeaders } from "./user-hosted-serving"

const LOCAL_TARGET = "http://127.0.0.1:2593/workspaces/ws_1/api/wr/health"

/** What Cloudflare and the browser add by the time the relay hands a request over. */
function relayDeliveredHeaders(): Record<string, string> {
  return {
    authorization: "Bearer runtime-access-token",
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-proto": "https",
    origin: "https://app.claxedo.test",
  }
}

describe("loopback replay headers", () => {
  /**
   * Asserted against the REAL gate the daemon mounts, not against a restatement
   * of the strip list — a list-shaped test would have passed while production
   * 403'd, which is exactly how this shipped.
   */
  test("turns a relay-delivered request into one the unsigned-local gate accepts", () => {
    const verbatim = new Request(LOCAL_TARGET, { headers: relayDeliveredHeaders() })
    expect(isLoopbackLocalRequest(verbatim)).toBe(false)

    const replay = new Request(LOCAL_TARGET, { headers: loopbackReplayHeaders(relayDeliveredHeaders()) })
    expect(isLoopbackLocalRequest(replay)).toBe(true)
  })

  test("keeps the credential and payload headers the workspace endpoint needs", () => {
    const sanitized = loopbackReplayHeaders(relayDeliveredHeaders())
    expect(sanitized["authorization"]).toBe("Bearer runtime-access-token")
    expect(sanitized["content-type"]).toBe("application/json")
  })

  test("strips regardless of header case, since the relay preserves the caller's casing", () => {
    const sanitized = loopbackReplayHeaders({ "CF-Connecting-IP": "203.0.113.7", Origin: "https://app.claxedo.test" })
    expect(Object.keys(sanitized)).toEqual([])
  })

  test("each forwarded signal alone is enough to be refused, so each is stripped", () => {
    for (const [name, value] of [
      ["cf-connecting-ip", "203.0.113.7"],
      ["x-forwarded-for", "203.0.113.7"],
      ["x-forwarded-proto", "https"],
      ["origin", "https://app.claxedo.test"],
    ] as const) {
      const one = { [name]: value }
      expect(isLoopbackLocalRequest(new Request(LOCAL_TARGET, { headers: one })), name).toBe(false)
      expect(
        isLoopbackLocalRequest(new Request(LOCAL_TARGET, { headers: loopbackReplayHeaders(one) })),
        name,
      ).toBe(true)
    }
  })

  test("a request with nothing to strip is unchanged", () => {
    expect(loopbackReplayHeaders({ authorization: "Bearer t" })).toEqual({ authorization: "Bearer t" })
  })
})
