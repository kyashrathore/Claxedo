import { describe, expect, test } from "bun:test"

import { createOwnerOperationBridge } from "./owner-operation-bridge"
import type {
  DiagnosticsOperationRequest,
  DiagnosticsOperationResult,
  DiagnosticsOwnerDescriptor,
} from "../../shared/diagnostics-transport"

const binding = { pid: 100, launchId: "server-launch", generation: "server-generation" }
const owner = {
  ownerId: "owner-managed",
  ownerGeneration: "owner-generation",
  ownerOperationId: "owner-operation",
  launchId: "process-launch",
  kind: "managed-process",
  role: "managed-process",
  label: "Development server",
  pid: 200,
  capabilities: { stopGracefully: true, killOwnedTree: true },
} satisfies DiagnosticsOwnerDescriptor
const identity = {
  id: "host:200:55",
  domain: "host" as const,
  pid: 200,
  creation: { state: "available" as const, value: "55", source: "linux-proc" as const },
  launchId: owner.launchId,
}

describe("diagnostics owner operation bridge", () => {
  test("allows the bounded owner stop path to outlive three seconds", async () => {
    let resolve: ((result: DiagnosticsOperationResult) => void) | undefined
    const bridge = createOwnerOperationBridge({
      binding,
      send(message) {
        if (message.type !== "owner-operation-request") return false
        setTimeout(() => {
          resolve?.({
            type: "owner-operation-result",
            binding,
            requestId: message.requestId,
            result: "completed",
          })
        }, 3_100)
        return true
      },
    })
    const operation = bridge.operationFor(owner)
    const result = new Promise<DiagnosticsOperationResult["result"]>((done) => {
      resolve = (message) => {
        bridge.onMessage(message)
        done(message.result)
      }
    })

    expect(await operation({
      action: "stop",
      identity,
      owner,
    })).toBe("completed")
    expect(await result).toBe("completed")
  }, 4_000)

  test("binds a request to the child launch, owner generation, and creation identity", async () => {
    let sent: DiagnosticsOperationRequest | undefined
    const bridge = createOwnerOperationBridge({
      binding,
      requestId: () => "request-000000000000000000000001",
      send(message) {
        sent = message
        return true
      },
    })
    const result = bridge.operationFor(owner)({
      action: "stop",
      owner,
      identity: {
        id: "host:200:55",
        domain: "host",
        pid: 200,
        creation: { state: "available", value: "55", source: "linux-proc" },
        launchId: owner.launchId,
      },
    })
    expect(sent).toEqual({
      type: "owner-operation-request",
      binding,
      requestId: "request-000000000000000000000001",
      ownerOperationId: owner.ownerOperationId,
      ownerGeneration: owner.ownerGeneration,
      operation: "stop",
      identity: { pid: 200, creation: "55" },
    })
    expect(bridge.onMessage({
      type: "owner-operation-result",
      binding,
      requestId: sent!.requestId,
      result: "completed",
    })).toBeTrue()
    expect(await result).toBe("completed")
    bridge.dispose()
  })

  test("rejects stale bindings, unknown results, and owner substitutions", async () => {
    const bridge = createOwnerOperationBridge({
      binding,
      send: () => false,
    })
    expect(bridge.onMessage({
      type: "owner-operation-result",
      binding: { ...binding, generation: "replacement" },
      requestId: "unknown-request",
      result: "completed",
    })).toBeFalse()
    expect(await bridge.operationFor(owner)({
      action: "kill",
      owner: { ...owner, ownerGeneration: "replacement" },
      identity: {
        id: "host:200:55",
        domain: "host",
        pid: 200,
        creation: { state: "available", value: "55", source: "linux-proc" },
        launchId: owner.launchId,
      },
    })).toBe("owner-unavailable")
    bridge.dispose()
  })
})
