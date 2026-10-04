import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { createSandboxManager, type SandboxDriver, type SandboxStartPhaseEvent } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import type { WorkspaceRuntimeRouteContext } from "@claxedo/workspace-runtime/route-contribution"
import { runtimeStartPhases } from "../hosts/workspace-runtime/runtime-start-phases"
import { recordRuntimeStartPhases } from "./runtime-start-phases"

const driver: SandboxDriver = {
  id: "test",
  metadata: {
    driverRunsIn: ["node"], hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host", targetAccess: "relay", secretBrokering: "none", egressControl: "hosts-and-cidrs",
    persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
  },
  ensureHost: async (input) => ({ sandboxId: "sb_1", url: "https://sandbox.test", hostId: "host_1", labels: input.labels }),
}

async function started() {
  const events: SandboxStartPhaseEvent[] = []
  const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver, onStartPhase: (event) => void events.push(event) })
  await sandboxManager.ensure("ws_1", { homeRegion: "us-east", labels: { projectId: "prj_1" } })
  events.length = 0
  return { sandboxManager, events }
}

function overRelay(routes: ReturnType<typeof runtimeStartPhases>["routes"]) {
  const relay = new Hono<{ Variables: RelayHostAuthContext }>()
  relay.use("*", async (c, next) => {
    c.set("relayHostAuth", { principal_kind: "service", actor_id: "control-plane" } as RelayHostAuthContext["relayHostAuth"])
    await next()
  })
  relay.route("/", routes.mount({} as WorkspaceRuntimeRouteContext).routes)
  return async (path: string, init: RequestInit) => await relay.request(path, init)
}

describe("runtime start phases", () => {
  test("a ready runtime's checkout joins its epoch's start with the repository size, once", async () => {
    const { sandboxManager, events } = await started()
    const runtime = runtimeStartPhases()
    await runtime.measure("repository_checkout", async () => {})
    runtime.repositorySize(8_192)
    const runtimeFetch = overRelay(runtime.routes)

    await recordRuntimeStartPhases({ sandboxManager, workspaceId: "ws_1", runtimeFetch })
    await recordRuntimeStartPhases({ sandboxManager, workspaceId: "ws_1", runtimeFetch })

    expect(events).toEqual([expect.objectContaining({
      phase: "repository_checkout", durationMs: expect.any(Number), repoSizeBytes: 8_192, epoch: 1, labels: expect.objectContaining({ projectId: "prj_1" }),
    })])
  })

  test("phases the control plane does not take from a runtime are dropped from its answer", async () => {
    const { sandboxManager, events } = await started()
    const runtimeFetch = async () => Response.json({
      phases: [{ phase: "runtime_ready", durationMs: 1 }, { phase: "repository_checkout", durationMs: -4 }, { phase: "start_script", durationMs: 30 }],
      repoSizeBytes: "big",
    })

    await recordRuntimeStartPhases({ sandboxManager, workspaceId: "ws_1", runtimeFetch })

    expect(events.map((event) => [event.phase, event.durationMs, event.repoSizeBytes])).toEqual([["start_script", 30, undefined]])
  })

  test("a runtime that refuses the take records nothing and says so", async () => {
    const { sandboxManager, events } = await started()
    await expect(recordRuntimeStartPhases({ sandboxManager, workspaceId: "ws_1", runtimeFetch: async () => new Response(null, { status: 404 }) }))
      .rejects.toThrow("404")
    expect(events).toEqual([])
  })
})
