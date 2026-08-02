import { describe, expect, test } from "bun:test"

import { matchesDiagnosticsBinding, parseDiagnosticsTransportMessage } from "./diagnostics-transport"

const binding = { pid: 100, launchId: "server-launch", generation: "desktop-generation" }

describe("diagnostics child transport", () => {
  test("accepts redacted launch-bound ownership events", () => {
    const result = parseDiagnosticsTransportMessage({
      type: "owner-registered",
      at: 10,
      binding,
      descriptor: {
        ownerId: "pty-1",
        ownerGeneration: "owner-generation",
        ownerOperationId: "operation-identity",
        launchId: "pty-launch",
        kind: "pty",
        role: "pty",
        label: "Terminal",
        pid: 200,
        workspaceId: "workspace-1",
        directory: "/tmp/workspace",
        capabilities: { stopGracefully: true, killOwnedTree: false },
      },
    })

    expect(result.success).toBeTrue()
    expect(matchesDiagnosticsBinding(binding, binding)).toBeTrue()
  })

  test("rejects wrong bindings and secret-bearing payload fields", () => {
    expect(
      matchesDiagnosticsBinding(binding, {
        ...binding,
        generation: "stale-generation",
      }),
    ).toBeFalse()
    expect(
      parseDiagnosticsTransportMessage({
        type: "owner-registered",
        at: 10,
        binding,
        descriptor: {
          ownerId: "shell-1",
          ownerGeneration: "owner-generation",
          ownerOperationId: "operation-identity",
          launchId: "shell-launch",
          kind: "session-shell",
          role: "session-shell",
          label: "Session shell",
          pid: 201,
          capabilities: { stopGracefully: true, killOwnedTree: true },
          env: { SECRET: "sentinel" },
          argv: ["sh", "-c", "sentinel"],
        },
      }).success,
    ).toBeFalse()
  })

  test("rejects unknown messages and malformed operation identities", () => {
    expect(parseDiagnosticsTransportMessage({ type: "diagnostics", command: "sentinel" }).success).toBeFalse()
    expect(
      parseDiagnosticsTransportMessage({
        type: "owner-operation-request",
        binding,
        requestId: "request-1",
        ownerOperationId: "operation-identity",
        ownerGeneration: "owner-generation",
        operation: "kill",
        identity: { pid: 0, creation: "start-ticks" },
      }).success,
    ).toBeFalse()
  })

  test("rejects contradictory owner kind and role", () => {
    expect(
      parseDiagnosticsTransportMessage({
        type: "owner-registered",
        at: 10,
        binding,
        descriptor: {
          ownerId: "pty-1",
          ownerGeneration: "owner-generation",
          ownerOperationId: "operation-identity",
          launchId: "pty-launch",
          kind: "pty",
          role: "harness",
          label: "Terminal",
          pid: 200,
          capabilities: { stopGracefully: true, killOwnedTree: false },
        },
      }).success,
    ).toBeFalse()
  })
})
