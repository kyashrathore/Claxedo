import { describe, expect, test } from "bun:test"
import { createAgentDriverRuntime } from "../src/agent-driver-runtime"

const base = { protocolVersion: 1 as const, kind: "request" as const }
const sha = "a".repeat(64)

describe("agent driver NDJSON runtime", () => {
  test("enforces prepare, launch, scenario, and shutdown ownership order", async () => {
    const calls: string[] = []
    const runtime = createAgentDriverRuntime({
      hello: () => ({ application: "claxedo" }),
      prepare: async () => { calls.push("prepare"); return { coverage: "exact" } },
      launch: async () => { calls.push("launch"); return { processes: [{ pid: 123, owner: "application" }] } },
      runScenario: async (params) => { calls.push(`run:${params.scenario}`); return { samples: [] } },
      inspect: async () => ({ surface: "visible" }),
      shutdown: async () => { calls.push("shutdown"); return { survivors: [] } },
    })

    const prepare = await runtime.handle(JSON.stringify({
      ...base,
      correlationId: "p",
      method: "prepare",
      params: {
        runDirectory: "/tmp/run",
        corpusPath: "/tmp/corpus.json",
        corpusDigestSha256: sha,
        profiles: ["workspace-core-v1"],
      },
    }))
    const launch = await runtime.handle(JSON.stringify({
      ...base, correlationId: "l", method: "launch", params: { isolatedProfilePath: "/tmp/profile" },
    }))
    const run = await runtime.handle(JSON.stringify({
      ...base,
      correlationId: "r",
      method: "run-scenario",
      params: {
        attemptId: "attempt-1",
        profile: "workspace-core-v1",
        scenario: "work-item-warm-switch-v1",
        seed: "42",
      },
    }))
    const shutdown = await runtime.handle(JSON.stringify({
      ...base, correlationId: "s", method: "shutdown", params: { reason: "complete" },
    }))
    const nextPrepare = await runtime.handle(JSON.stringify({
      ...base,
      correlationId: "p2",
      method: "prepare",
      params: {
        runDirectory: "/tmp/run-2",
        corpusPath: "/tmp/corpus.json",
        corpusDigestSha256: sha,
        profiles: ["workspace-core-v1"],
      },
    }))

    expect([prepare, launch, run, shutdown, nextPrepare].map((value) => value.ok)).toEqual([true, true, true, true, true])
    expect(calls).toEqual(["prepare", "launch", "run:work-item-warm-switch-v1", "shutdown", "prepare"])
  })

  test("returns bounded correlated errors and rejects duplicate correlation IDs", async () => {
    const runtime = createAgentDriverRuntime({
      hello: () => ({}),
      prepare: async () => ({}),
      launch: async () => ({}),
      runScenario: async () => ({}),
      inspect: async () => ({}),
      shutdown: async () => ({}),
    })
    const beforePrepare = await runtime.handle(JSON.stringify({
      ...base, correlationId: "same", method: "launch", params: { isolatedProfilePath: "/tmp/profile" },
    }))
    const duplicate = await runtime.handle(JSON.stringify({
      ...base, correlationId: "same", method: "hello", params: { frameworkVersion: 1 },
    }))

    expect(beforePrepare).toMatchObject({
      kind: "response", method: "launch", ok: false, correlationId: "same", error: { code: "invalid-lifecycle" },
    })
    expect(duplicate).toMatchObject({
      kind: "response", method: "hello", ok: false, correlationId: "same", error: { code: "duplicate-correlation-id" },
    })
  })
})
