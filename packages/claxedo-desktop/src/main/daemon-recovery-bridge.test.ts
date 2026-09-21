import { describe, expect, test } from "bun:test"
import type { CreationIdentity } from "@claxedo/agent-sdk-runtime/launch"

import { daemonRecoveryBridge, type DaemonOwnershipView, type DaemonRecoveryResult } from "./daemon-recovery"
import { CLAXEDO_DAEMON_PROTOCOL, type ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

const GENERATION = "generation-1"

function identity(): CreationIdentity {
  return {
    pid: 4242,
    processGroupId: 4242,
    parentPid: 1,
    startSecond: "Thu Jan  1 00:00:00 1970",
    startedAtMs: 0,
    bootTime: "0",
    source: "darwin-ps",
  }
}

function discovery(): ClaxedoDaemonDiscovery {
  return {
    service: "claxedo-local-daemon",
    protocol: CLAXEDO_DAEMON_PROTOCOL,
    generation: GENERATION,
    token: "secret",
    pid: 4242,
    port: 2593,
    startedAt: "2026-09-21T00:00:00.000Z",
    identity: identity(),
  }
}

function snapshot(overrides: Partial<DaemonOwnershipView> = {}): DaemonOwnershipView {
  return {
    machineId: "local",
    generation: GENERATION,
    pid: 4242,
    revision: "rev-1",
    writtenAt: Date.now(),
    residencyPins: 1,
    owners: [{ id: "workspace:ws_a", kind: "workspace_runtime", generation: "mount-1", state: "serving", pins: false }],
    ...overrides,
  }
}

function unresolved(): { discovery: ClaxedoDaemonDiscovery; result: DaemonRecoveryResult } {
  return {
    discovery: discovery(),
    result: {
      replacementAllowed: false,
      outcome: {
        kind: "operation",
        operation: {
          operationId: "op-launch", requestId: "desktop-launch", target: { scope: "machine", machineId: "local", ownerGeneration: GENERATION },
          action: "stop_daemon", scopeRevision: "rev-1", attempt: 1, state: "needs_action", phase: "ack",
          phaseDeadlineAt: 1, facts: {
            execution: { value: "running", source: "desktop-launcher", observedAt: 1, generation: GENERATION },
            cleanup: { value: "owned", source: "desktop-launcher", observedAt: 1, generation: GENERATION },
            persistence: { value: "unavailable", source: "desktop-launcher", observedAt: 1, generation: GENERATION },
          },
          cleanupErrors: [], nextActions: [], receipt: "volatile", createdAt: 1, updatedAt: 1,
        },
      },
    },
  }
}

/** The bridge with no daemon to forward to: the external recovery path. */
function externalBridge(options: { snapshot?: DaemonOwnershipView | undefined; recovered?: DaemonRecoveryResult[] } = {}) {
  const recovered = options.recovered ?? []
  return daemonRecoveryBridge({
    daemon: () => undefined,
    unresolved: () => unresolved(),
    ownershipView: () => ("snapshot" in options ? options.snapshot : snapshot()),
    onRecovered: (result) => { recovered.push(result) },
  })
}

function stopRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "stop-1",
    action: "stop_daemon",
    target: { scope: "machine", machineId: "local", ownerGeneration: GENERATION },
    scopeRevision: "rev-1",
    attempt: 1,
    ...overrides,
  }
}

describe("the daemon recovery bridge, with no daemon to ask", () => {
  test("a body it cannot read is refused before anything acts on it", async () => {
    const bridge = externalBridge()

    for (const body of [undefined, {}, { action: "stop_daemon" }, stopRequest({ attempt: 0 })]) {
      const outcome = await bridge.submit(body)
      expect(outcome.kind, JSON.stringify(body)).toBe("refused")
      if (outcome.kind === "refused") expect(outcome.refusal.kind).toBe("unavailable")
    }
  })

  test("a stop naming another daemon generation is refused with the one published here", async () => {
    const bridge = externalBridge()

    const outcome = await bridge.submit(stopRequest({
      target: { scope: "machine", machineId: "local", ownerGeneration: "generation-0" },
    }))

    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused" || outcome.refusal.kind !== "generation_conflict") {
      throw new Error("expected generation_conflict")
    }
    expect(outcome.refusal.current).toEqual({ scope: "machine", machineId: "local", ownerGeneration: GENERATION })
  })

  test("a stop authorized against a revision this daemon has not published is refused", async () => {
    const bridge = externalBridge({ snapshot: snapshot({ revision: "rev-2" }) })

    const outcome = await bridge.submit(stopRequest({ scopeRevision: "rev-1" }))

    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused" || outcome.refusal.kind !== "scope_changed") throw new Error("expected scope_changed")
    expect(outcome.refusal.scopeRevision).toBe("rev-2")
  })

  test("a snapshot from another generation makes the revision unverified, and only that is accepted", async () => {
    const bridge = externalBridge({ snapshot: snapshot({ generation: "generation-0" }) })

    const refused = await bridge.submit(stopRequest({ scopeRevision: "rev-1" }))
    expect(refused.kind).toBe("refused")
    if (refused.kind === "refused" && refused.refusal.kind === "scope_changed") {
      expect(refused.refusal.scopeRevision).toBe("unverified")
    }
  })

  test("an action other than a stop is refused: there is no daemon to do it", async () => {
    const bridge = externalBridge()

    const outcome = await bridge.submit(stopRequest({ action: "drain_daemon", requestId: "drain-1" }))

    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.refusal.kind).toBe("unavailable")
      expect(outcome.refusal.message).toContain("drain_daemon")
    }
  })

  test("the inspection answers the daemon route's own shape, with a volatile receipt", async () => {
    const inspected = await externalBridge().inspect()

    expect(Object.keys(inspected).sort()).toEqual([
      "generation", "machineId", "operations", "owners", "preview", "receipt", "residencyPins", "scopeRevision", "target",
    ])
    expect(inspected.receipt).toBe("volatile")
    expect(inspected.scopeRevision).toBe("rev-1")
    expect(inspected.owners.map((owner) => owner.id)).toEqual(["workspace:ws_a"])
    expect(inspected.preview.summary).toContain("additional impact is unknown")
  })

  test("with no daemon published at all, the inspection is empty rather than absent", async () => {
    const bridge = daemonRecoveryBridge({
      daemon: () => undefined,
      unresolved: () => undefined,
      ownershipView: () => undefined,
      onRecovered: () => {},
    })

    const inspected = await bridge.inspect()
    expect(inspected.owners).toEqual([])
    expect(inspected.operations).toEqual([])
    expect(inspected.preview.summary).toContain("no daemon is published")
  })
})

describe("the daemon recovery bridge, forwarding to a live daemon", () => {
  function forwarding(answer: (path: string, init?: RequestInit) => Response) {
    const seen: Array<{ path: string; body: unknown }> = []
    const bridge = daemonRecoveryBridge({
      daemon: () => async (path, init) => {
        seen.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return answer(path, init)
      },
      unresolved: () => undefined,
      ownershipView: () => undefined,
      onRecovered: () => {},
    })
    return { bridge, seen }
  }

  test("a body it cannot read is never relayed under the machine capability", async () => {
    const { bridge, seen } = forwarding(() => Response.json({ kind: "operation" }))

    const outcome = await bridge.submit({ action: "stop_daemon" })

    expect(outcome.kind).toBe("refused")
    expect(seen, "nothing reached the daemon").toEqual([])
  })

  test("a request it can read is forwarded and its answer parsed", async () => {
    const operation = unresolved().result.outcome
    const { bridge, seen } = forwarding(() => Response.json(operation))

    const outcome = await bridge.submit(stopRequest())

    expect(seen.map((call) => call.path)).toEqual(["/api/claxedo/daemon/recovery"])
    expect(seen[0]?.body).toMatchObject({ action: "stop_daemon", scopeRevision: "rev-1" })
    expect(outcome.kind === "operation" && outcome.operation.operationId).toBe("op-launch")
  })

  test("reading an operation with no id names nothing rather than asking for everything", async () => {
    const { bridge, seen } = forwarding(() => Response.json({ kind: "operation" }))

    const outcome = await bridge.read("")

    expect(outcome.kind).toBe("refused")
    expect(seen).toEqual([])
  })
})
