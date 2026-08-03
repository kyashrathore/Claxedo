import { describe, expect, test, vi } from "vitest"
import type { CommandResult, WorkGraphCommandRequest, WorkGraphContext } from "@claxedo/workgraph/contracts"
import { Hono } from "hono"
import {
  createWorkGraphOperationalReporter,
  instrumentWorkGraphCommands,
  workGraphHttpTelemetry,
  workGraphMonitorContract,
} from "./operational-telemetry"
import { createHostedWorkGraphRuntime } from "./hosted/runtime"
import type { ControlPlaneServices } from "../../authority/services"

describe("WorkGraph operational telemetry", () => {
  test("publishes executable bounded monitor thresholds", () => {
    expect(
      workGraphMonitorContract({
        CLAXEDO_WORKGRAPH_ALERT_WINDOW_MS: "60000",
        CLAXEDO_WORKGRAPH_ALERT_COMMAND_ERRORS: "2",
        CLAXEDO_WORKGRAPH_ALERT_LAG_MS: "9000",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "command_errors", signal: "count", threshold: 2, windowMs: 60_000 }),
        expect.objectContaining({ name: "lag", signal: "gauge", threshold: 9_000, windowMs: 60_000 }),
      ]),
    )
  })

  test("emits one alert per monitor window and only content-free properties", () => {
    const capture = vi.fn()
    let now = 10
    const reporter = createWorkGraphOperationalReporter({
      telemetry: { capture },
      env: { CLAXEDO_WORKGRAPH_ALERT_COMMAND_ERRORS: "2", CLAXEDO_WORKGRAPH_ALERT_WINDOW_MS: "100" },
      now: () => now,
    })
    reporter.command({ command: "create_stream", status: "error", code: "validation_error", latencyMs: 4 })
    reporter.command({ command: "create_stream", status: "error", code: "validation_error", latencyMs: 5 })
    reporter.command({ command: "create_stream", status: "error", code: "validation_error", latencyMs: 6 })
    expect(capture.mock.calls.filter((call) => call[1] === "workgraph.alert")).toHaveLength(1)
    now = 111
    reporter.command({ command: "create_stream", status: "error", code: "validation_error", latencyMs: 7 })
    reporter.command({ command: "create_stream", status: "error", code: "validation_error", latencyMs: 8 })
    expect(capture.mock.calls.filter((call) => call[1] === "workgraph.alert")).toHaveLength(2)
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(
      /organization|owner|prompt|title|sourceText|credential|https?:\/\//i,
    )
  })

  test("instruments command latency, error code, and close-required lifecycle without changing results", async () => {
    const capture = vi.fn()
    const reporter = createWorkGraphOperationalReporter({ telemetry: { capture } })
    const result = {
      ok: false,
      operationId: "operation" as never,
      error: { code: "close_required", message: "Close first", retryable: false },
    } satisfies CommandResult
    const service = instrumentWorkGraphCommands(
      {
        execute: vi.fn(async (_context: WorkGraphContext, _request: WorkGraphCommandRequest) => result),
      },
      reporter,
      sequence(10, 16),
    )
    await expect(
      service.execute(context(), {
        operationId: "operation" as never,
        command: {
          version: 1,
          type: "delete_stream",
          streamId: "stream" as never,
          expectedVersion: 1,
          reason: "No longer needed",
        },
      } satisfies WorkGraphCommandRequest),
    ).resolves.toBe(result)
    expect(capture).toHaveBeenCalledWith("system", "workgraph.command", {
      command: "delete_stream",
      status: "error",
      code: "close_required",
      count: 1,
      latencyMs: 6,
    })
    expect(capture).toHaveBeenCalledWith("system", "workgraph.stream_lifecycle", {
      operation: "delete",
      outcome: "close_required",
      count: 1,
    })
  })

  // Cursor telemetry (which classified `/changes` long-poll responses) is gone:
  // the route was deleted and the doorbell has no response
  // envelope to classify, so HTTP telemetry only classifies connector surfaces now.
  test("observes connector authentication without reading content", async () => {
    const capture = vi.fn()
    const reporter = createWorkGraphOperationalReporter({ telemetry: { capture } })
    const app = new Hono()
    app.use("*", workGraphHttpTelemetry(reporter, sequence(1, 11, 20, 25, 30, 31)))
    app.get("/api/workgraph/source-views", (context) => context.json({ error: { code: "forbidden" } }, 401))

    await app.request("/api/workgraph/source-views")

    expect(capture).toHaveBeenCalledWith("system", "workgraph.connector", {
      surface: "source_view",
      outcome: "auth_failed",
      latencyMs: 10,
      status: 401,
      count: 1,
    })
  })

  test("is consumed by the hosted reconciler and emits queue plus outcome observations", async () => {
    const capture = vi.fn()
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-token",
      },
      { telemetry: { capture } } as unknown as ControlPlaneServices,
      {
        background: false,
        now: sequence(100, 110, 120),
        executor: {
          query: vi.fn(async () => []),
          mutation: vi.fn(async (_fn, args) => (args.limit === 500 ? [] : [])),
        },
      },
    )
    await runtime?.reconcile({ trigger: "nudge" })
    expect(capture).toHaveBeenCalledWith("system", "workgraph.queue", expect.objectContaining({ kind: "run" }))
    expect(capture).toHaveBeenCalledWith(
      "system",
      "workgraph.reconciliation",
      expect.objectContaining({
        trigger: "nudge",
        outcome: "succeeded",
        claimed: 0,
        running: 0,
      }),
    )
  })
})

function sequence(...values: number[]) {
  const next = vi.fn()
  values.forEach((value) => next.mockReturnValueOnce(value))
  return next
}

function context(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: "owner" as never,
    actor: { type: "user", id: "owner" as never },
    requestId: "request" as never,
    access: { mode: "owner" },
  }
}
