import { describe, expect, test } from "bun:test"
import { centralTransportForDeployment, centralTransportForServer } from "./server-transport"

describe("centralTransportForServer", () => {
  test("a loopback server is loopback; anything else is signed web", () => {
    expect(centralTransportForServer("http://127.0.0.1:2593")).toBe("loopback")
    expect(centralTransportForServer("https://localhost:4449")).toBe("loopback")
    expect(centralTransportForServer("https://cf.example.dev")).toBe("signed-web")
  })
})

describe("centralTransportForDeployment", () => {
  test("a build with auth enabled is signed web even against a localhost server", () => {
    expect(centralTransportForDeployment({ serverUrl: "https://localhost:4449", authEnabled: true })).toBe("signed-web")
    expect(centralTransportForDeployment({ serverUrl: "http://127.0.0.1:2593", authEnabled: true })).toBe("signed-web")
  })

  test("without auth the loopback rule stands", () => {
    expect(centralTransportForDeployment({ serverUrl: "http://127.0.0.1:2593", authEnabled: false })).toBe("loopback")
    expect(centralTransportForDeployment({ serverUrl: "https://cf.example.dev", authEnabled: false })).toBe("signed-web")
  })
})
