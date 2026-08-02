import { describe, expect, test } from "bun:test"

import type { DiagnosticsTransportMessage } from "../src/shared/diagnostics-transport"
import {
  createDiagnosticsChildTransport,
  windowsIdentityProbeCommand,
} from "./diagnostics-child-transport"

const binding = { pid: 50, launchId: "server-launch", generation: "server-generation" }

describe("diagnostics child owner transport", () => {
  test("builds a bounded Windows identity-only probe from a validated PID", () => {
    const command = windowsIdentityProbeCommand(75, String.raw`C:\Windows`)
    const script = command.args.at(-1)!

    expect(command.executable).toEndWith("System32/WindowsPowerShell/v1.0/powershell.exe")
    expect(command.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    expect(script).toContain("Win32_Process")
    expect(script).toContain("ProcessId,CreationDate")
    expect(script).not.toContain("CommandLine")
    expect(script).not.toContain("WorkingSet")
    expect(command.options.env.CLAXEDO_DIAGNOSTICS_PID).toBe("75")
    expect(command.options.timeout).toBe(2_000)
    expect(command.options.maxBuffer).toBe(4_096)
    expect(() => windowsIdentityProbeCommand(0)).toThrow("PID is invalid")
  })

  test("checks binding, operation identity, generation, live identity, and duplicate requests", async () => {
    const sent: DiagnosticsTransportMessage[] = []
    let stops = 0
    const transport = createDiagnosticsChildTransport({
      binding,
      send: (message) => sent.push(message),
      revalidateIdentity: async (identity) => identity.creation === "start-ticks",
    })
    transport.observer.register(
      {
        ownerId: "managed-1",
        ownerGeneration: "owner-generation",
        launchId: "managed-launch",
        kind: "managed-process",
        role: "managed-process",
        label: "Managed process",
        pid: 75,
        workspaceId: "workspace-1",
      },
      { stopGracefully: async () => { stops++ } },
    )
    const registration = sent[0]
    if (registration?.type !== "owner-registered") throw new Error("Expected owner registration")
    const request = {
      type: "owner-operation-request" as const,
      binding,
      requestId: "request-1",
      ownerOperationId: registration.descriptor.ownerOperationId,
      ownerGeneration: registration.descriptor.ownerGeneration,
      operation: "stop" as const,
      identity: { pid: 75, creation: "start-ticks" },
    }

    await transport.onMessage({ ...request, binding: { ...binding, generation: "stale" } })
    expect(stops).toBe(0)
    await transport.onMessage({ ...request, ownerGeneration: "stale-owner" })
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "owner-unavailable" })
    await transport.onMessage({ ...request, requestId: "request-2", identity: { pid: 75, creation: "reused" } })
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "identity-mismatch" })
    await transport.onMessage({ ...request, requestId: "request-3" })
    expect(stops).toBe(1)
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "completed" })
    await transport.onMessage({ ...request, requestId: "request-3" })
    expect(stops).toBe(1)
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "duplicate-request" })
  })

  test("rotates operation identities and deletes them on owner exit", async () => {
    const sent: DiagnosticsTransportMessage[] = []
    const transport = createDiagnosticsChildTransport({
      binding,
      send: (message) => sent.push(message),
      revalidateIdentity: async () => true,
    })
    const descriptor = {
      ownerId: "pty-1",
      ownerGeneration: "owner-generation",
      launchId: "pty-launch",
      kind: "pty" as const,
      role: "pty" as const,
      label: "Terminal",
      pid: 75,
    }
    const first = transport.observer.register(descriptor, { stopGracefully: async () => undefined })
    first.exit({ reason: "exited" })
    transport.observer.register(descriptor, { stopGracefully: async () => undefined })
    const registrations = sent.filter((message) => message.type === "owner-registered")
    expect(registrations).toHaveLength(2)
    expect(registrations[0]!.descriptor.ownerOperationId).not.toBe(registrations[1]!.descriptor.ownerOperationId)

    await transport.onMessage({
      type: "owner-operation-request",
      binding,
      requestId: "request-old-operation",
      ownerOperationId: registrations[0]!.descriptor.ownerOperationId,
      ownerGeneration: "owner-generation",
      operation: "stop",
      identity: { pid: 75, creation: "start-ticks" },
    })
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "owner-unavailable" })
  })

  test("accepts an owner operation after a delayed PID update", async () => {
    const sent: DiagnosticsTransportMessage[] = []
    let stopped = false
    const transport = createDiagnosticsChildTransport({
      binding,
      send: (message) => sent.push(message),
      revalidateIdentity: async () => true,
    })
    const owner = transport.observer.register(
      {
        ownerId: "managed-delayed",
        ownerGeneration: "owner-generation",
        launchId: "managed-launch",
        kind: "managed-process",
        role: "managed-process",
        label: "Managed process",
      },
      { stopGracefully: async () => {
        stopped = true
      } },
    )
    owner.update({ pid: 77, lifecycle: "ready" })
    const registration = sent.find((message) => message.type === "owner-registered")
    if (registration?.type !== "owner-registered") throw new Error("Expected owner registration")

    await transport.onMessage({
      type: "owner-operation-request",
      binding,
      requestId: "request-delayed-pid",
      ownerOperationId: registration.descriptor.ownerOperationId,
      ownerGeneration: registration.descriptor.ownerGeneration,
      operation: "stop",
      identity: { pid: 77, creation: "start-ticks" },
    })

    expect(stopped).toBeTrue()
    expect(sent.at(-1)).toMatchObject({ type: "owner-operation-result", result: "completed" })
    transport.dispose()
  })
})
