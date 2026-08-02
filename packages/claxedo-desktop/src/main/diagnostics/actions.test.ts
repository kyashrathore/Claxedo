import { describe, expect, test } from "bun:test"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import { createDiagnosticsActions } from "./actions"
import type { DiagnosticsOwnerDescriptor } from "../../shared/diagnostics-transport"

const descriptor = {
  ownerId: "owner-managed-1",
  ownerGeneration: "owner-generation-1",
  ownerOperationId: "owner-operation-1",
  launchId: "launch-managed-1",
  kind: "managed-process",
  role: "managed-process",
  label: "Development server",
  pid: 4242,
  capabilities: {
    stopGracefully: true,
    killOwnedTree: true,
  },
} satisfies DiagnosticsOwnerDescriptor

const owner = {
  id: descriptor.ownerId,
  kind: descriptor.kind,
  label: descriptor.label,
  launchId: descriptor.launchId,
  access: "local",
  lifecycle: "current",
} satisfies LocalDiagnostics.OwnerIdentity

const processRecord = {
  identity: {
    id: "host:4242:100",
    domain: "host",
    pid: 4242,
    creation: {
      state: "available",
      value: "100",
      source: "linux-proc",
    },
    launchId: descriptor.launchId,
  },
  ownerId: descriptor.ownerId,
  role: "managed-process",
  label: descriptor.label,
  lifecycle: "running",
  actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
} satisfies LocalDiagnostics.ProcessRecord

describe("diagnostics owner actions", () => {
  test("issues opaque owner-bound grants and keeps stop distinct from kill", async () => {
    const invoked: LocalDiagnostics.ActionKind[] = []
    const actions = createDiagnosticsActions({
      generation: "profiler-generation-1",
      now: () => 1_000,
      token: (() => {
        let sequence = 0
        return () => `opaque-diagnostics-token-${String(++sequence).padStart(4, "0")}`
      })(),
    })
    actions.register(descriptor, async (input) => {
      invoked.push(input.action)
      return "completed"
    })

    const eligibility = actions.eligibility(processRecord, owner)
    expect(eligibility.state).toBe("eligible")
    if (eligibility.state !== "eligible") throw new Error("expected eligible action")
    expect(eligibility.actions.map((grant) => grant.action)).toEqual(["stop", "kill"])
    const stop = actions.claim({ action: "stop", token: eligibility.actions[0]!.token })
    expect(stop.ok).toBeTrue()
    if (!stop.ok) throw new Error("expected action claim")
    expect(await actions.execute({
      claim: stop.claim,
      resolveProcess: () => processRecord,
      revalidate: async () => true,
    })).toEqual({ ok: true })
    expect(invoked).toEqual(["stop"])

    const kill = actions.claim({ action: "kill", token: eligibility.actions[1]!.token })
    expect(kill.ok).toBeTrue()
    if (!kill.ok) throw new Error("expected action claim")
    expect(await actions.execute({
      claim: kill.claim,
      resolveProcess: () => processRecord,
      revalidate: async () => true,
    })).toEqual({ ok: true })
    expect(invoked).toEqual(["stop", "kill"])
  })

  test("rejects expired and reused tokens before invoking the owner", () => {
    let at = 1_000
    const actions = createDiagnosticsActions({
      generation: "profiler-generation-1",
      now: () => at,
      ttlMs: 10,
      token: (() => {
        let sequence = 0
        return () => `opaque-diagnostics-token-expired-${String(++sequence)}`
      })(),
    })
    actions.register(descriptor, async () => "completed")
    const eligibility = actions.eligibility(processRecord, owner)
    if (eligibility.state !== "eligible") throw new Error("expected eligible action")
    at = 1_011
    expect(actions.claim({ action: "stop", token: eligibility.actions[0]!.token })).toEqual({
      ok: false,
      result: { ok: false, action: "stop", code: "expired-token" },
    })
    expect(actions.claim({ action: "stop", token: eligibility.actions[0]!.token })).toEqual({
      ok: false,
      result: { ok: false, action: "stop", code: "invalid-token" },
    })
  })

  test("fails closed on PID reuse, exit, detach, and protected owners", async () => {
    const actions = createDiagnosticsActions({
      generation: "profiler-generation-1",
      token: (() => {
        let sequence = 0
        return () => `opaque-diagnostics-token-identity-${String(++sequence)}`
      })(),
    })
    actions.register(descriptor, async () => "completed")
    const eligibility = actions.eligibility(processRecord, owner)
    if (eligibility.state !== "eligible") throw new Error("expected eligible action")
    const claimed = actions.claim({ action: "stop", token: eligibility.actions[0]!.token })
    if (!claimed.ok) throw new Error("expected action claim")
    expect(await actions.execute({
      claim: claimed.claim,
      resolveProcess: () => ({
        ...processRecord,
        identity: {
          ...processRecord.identity,
          id: "host:4242:replacement",
          creation: { ...processRecord.identity.creation, value: "replacement" },
        },
      }),
      revalidate: async () => true,
    })).toEqual({ ok: false, code: "identity-mismatch" })

    actions.update({
      ownerId: descriptor.ownerId,
      ownerGeneration: descriptor.ownerGeneration,
      lifecycle: "detached",
      pid: descriptor.pid,
    })
    expect(actions.eligibility(processRecord, owner)).toEqual({ state: "ineligible", reason: "detached" })
    expect(actions.eligibility(processRecord, {
      ...owner,
      id: "owner-electron-main",
      kind: "electron-main",
    })).toEqual({ state: "ineligible", reason: "protected-process" })
  })

  test("never grants an action without exact platform identity and a live owner callback", () => {
    const actions = createDiagnosticsActions({ generation: "profiler-generation-1" })
    actions.register(descriptor)
    expect(actions.eligibility(processRecord, owner)).toEqual({
      state: "ineligible",
      reason: "owner-operation-unavailable",
    })
    actions.register(descriptor, async () => "completed")
    expect(actions.eligibility({
      ...processRecord,
      identity: {
        ...processRecord.identity,
        creation: { state: "unavailable", reason: "identity-unavailable" },
      },
    }, owner)).toEqual({
      state: "ineligible",
      reason: "identity-unavailable",
    })
  })
})
