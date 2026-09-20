import { describe, expect, test } from "bun:test"
import { centralTransportForServer } from "./server-transport"

describe("centralTransportForServer", () => {
  // It answers the wire, never the posture: a signed self-hosted node runs its
  // own issuer on localhost, so `localhost` here is the same answer as the
  // daemon's and is right to be.
  test("a loopback server is loopback; anything else is signed web", () => {
    expect(centralTransportForServer("http://127.0.0.1:2593")).toBe("loopback")
    expect(centralTransportForServer("https://localhost:4449")).toBe("loopback")
    expect(centralTransportForServer("http://localhost:3001")).toBe("loopback")
    expect(centralTransportForServer("https://cf.example.dev")).toBe("signed-web")
  })
})
