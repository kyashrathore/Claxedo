import { describe, expect, test } from "bun:test"
import { decodeDriverRequest, driverHello } from "../src/agent-driver-contract"

const sha = "a".repeat(64)

describe("agent-app driver contract", () => {
  test("advertises the exact T3 v1 Claxedo capabilities and all primary metrics", () => {
    const hello = driverHello({ applicationVersion: "test-sha", driverVersion: "1", driverDigestSha256: sha })
    expect(hello).toMatchObject({
      protocolVersion: 1,
      application: { name: "Claxedo", version: "test-sha", build: "release" },
      capabilities: {
        profiles: ["workspace-core-v1", "conversation-rich-v1", "terminal-core-v1", "resource-core-v1"],
      },
    })
    expect(hello.capabilities.metrics).toHaveLength(10)
    expect(new Set(hello.capabilities.metrics).size).toBe(10)
  })

  test("decodes T3 lifecycle requests without accepting ambient launch configuration", () => {
    expect(decodeDriverRequest(JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      correlationId: "req-1",
      method: "prepare",
      params: {
        runDirectory: "/tmp/run",
        corpusPath: "/tmp/corpus.json",
        corpusDigestSha256: sha,
        profiles: ["workspace-core-v1"],
      },
    }))).toMatchObject({ method: "prepare", correlationId: "req-1" })

    expect(() => decodeDriverRequest(JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      correlationId: "req-2",
      method: "launch",
      params: { isolatedProfilePath: "/tmp/profile", env: { HOME: "/private/user" } },
    }))).toThrow("unknown field")
  })

  test("rejects unknown versions, methods, profiles, scenarios, and obsolete profile names", () => {
    expect(() => decodeDriverRequest(JSON.stringify({
      protocolVersion: 2, kind: "request", correlationId: "x", method: "hello", params: { frameworkVersion: 1 },
    }))).toThrow("protocolVersion")
    expect(() => decodeDriverRequest(JSON.stringify({
      protocolVersion: 1, kind: "request", correlationId: "x", method: "shell", params: {},
    }))).toThrow("method")
    expect(() => decodeDriverRequest(JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      correlationId: "x",
      method: "prepare",
      params: {
        runDirectory: "/tmp/run",
        corpusPath: "/tmp/corpus",
        corpusDigestSha256: sha,
        profiles: ["conversation-core-v1"],
      },
    }))).toThrow("profile")
  })
})
