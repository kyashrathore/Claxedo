import type { MiddlewareHandler } from "hono"
import type {
  CommandErrorCode,
  CommandResult,
  WorkGraphCommandRequest,
  WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import type { ControlPlaneTelemetry } from "../control-plane/services"

export type WorkGraphTelemetryEnv = Readonly<
  Record<string, string | undefined> & {
    CLAXEDO_WORKGRAPH_ALERT_WINDOW_MS?: string
    CLAXEDO_WORKGRAPH_ALERT_COMMAND_ERRORS?: string
    CLAXEDO_WORKGRAPH_ALERT_RECONCILE_FAILURES?: string
    CLAXEDO_WORKGRAPH_ALERT_EXPIRED_RECOVERIES?: string
    CLAXEDO_WORKGRAPH_ALERT_GENERATION_FAILURES?: string
    CLAXEDO_WORKGRAPH_ALERT_CONNECTOR_AUTH_FAILURES?: string
    CLAXEDO_WORKGRAPH_ALERT_WORKSPACE_FAILURES?: string
    CLAXEDO_WORKGRAPH_ALERT_CLOSE_REQUIRED?: string
    CLAXEDO_WORKGRAPH_ALERT_BACKLOG?: string
    CLAXEDO_WORKGRAPH_ALERT_LAG_MS?: string
  }
>

export type WorkGraphMonitorName =
  | "command_errors"
  | "reconcile_failures"
  | "expired_lease_recoveries"
  | "generation_failures"
  | "connector_auth_failures"
  | "workspace_failures"
  | "close_required"
  | "backlog"
  | "lag"

export type WorkGraphMonitor = Readonly<{
  name: WorkGraphMonitorName
  signal: "count" | "gauge"
  threshold: number
  windowMs: number
  severity: "warning" | "critical"
}>

export type WorkGraphOperationalReporter = ReturnType<typeof createWorkGraphOperationalReporter>
export type WorkGraphReconciliationTrigger = "nudge" | "cron"

const defaultWindowMs = 5 * 60_000

export function workGraphMonitorContract(env: WorkGraphTelemetryEnv = {}): readonly WorkGraphMonitor[] {
  const windowMs = positive(env.CLAXEDO_WORKGRAPH_ALERT_WINDOW_MS, defaultWindowMs)
  return [
    monitor("command_errors", "count", env.CLAXEDO_WORKGRAPH_ALERT_COMMAND_ERRORS, 10, windowMs, "critical"),
    monitor("reconcile_failures", "count", env.CLAXEDO_WORKGRAPH_ALERT_RECONCILE_FAILURES, 1, windowMs, "critical"),
    monitor(
      "expired_lease_recoveries",
      "count",
      env.CLAXEDO_WORKGRAPH_ALERT_EXPIRED_RECOVERIES,
      3,
      windowMs,
      "warning",
    ),
    monitor("generation_failures", "count", env.CLAXEDO_WORKGRAPH_ALERT_GENERATION_FAILURES, 3, windowMs, "critical"),
    monitor(
      "connector_auth_failures",
      "count",
      env.CLAXEDO_WORKGRAPH_ALERT_CONNECTOR_AUTH_FAILURES,
      3,
      windowMs,
      "critical",
    ),
    monitor("workspace_failures", "count", env.CLAXEDO_WORKGRAPH_ALERT_WORKSPACE_FAILURES, 3, windowMs, "critical"),
    monitor("close_required", "count", env.CLAXEDO_WORKGRAPH_ALERT_CLOSE_REQUIRED, 5, windowMs, "warning"),
    monitor("backlog", "gauge", env.CLAXEDO_WORKGRAPH_ALERT_BACKLOG, 20, windowMs, "warning"),
    monitor("lag", "gauge", env.CLAXEDO_WORKGRAPH_ALERT_LAG_MS, 10 * 60_000, windowMs, "critical"),
  ]
}

export function createWorkGraphOperationalReporter(
  input: Readonly<{
    telemetry: ControlPlaneTelemetry
    env?: WorkGraphTelemetryEnv
    now?: () => number
  }>,
) {
  const now = input.now ?? Date.now
  const monitors = workGraphMonitorContract(input.env)
  const windows = new Map<WorkGraphMonitorName, { startedAt: number; value: number; alerted: boolean }>()
  const capture = (event: string, properties: Record<string, string | number | boolean>) => {
    try {
      input.telemetry.capture("system", event, properties)
    } catch {
      // Operational evidence never changes WorkGraph behavior.
    }
  }
  const observe = (name: WorkGraphMonitorName, value: number) => {
    const definition = monitors.find((candidate) => candidate.name === name)!
    const time = now()
    const previous = windows.get(name)
    const current =
      !previous || time - previous.startedAt >= definition.windowMs
        ? { startedAt: time, value: definition.signal === "count" ? value : Math.max(0, value), alerted: false }
        : {
            ...previous,
            value: definition.signal === "count" ? previous.value + value : Math.max(0, value),
          }
    windows.set(name, current)
    if (current.alerted || current.value < definition.threshold) return
    current.alerted = true
    capture("workgraph.alert", {
      monitor: definition.name,
      severity: definition.severity,
      signal: definition.signal,
      observed: current.value,
      threshold: definition.threshold,
      windowMs: definition.windowMs,
    })
  }
  return {
    monitors,
    command(
      input: Readonly<{
        command: string
        status: "ok" | "error"
        code?: CommandErrorCode | "internal_error"
        latencyMs: number
      }>,
    ) {
      capture("workgraph.command", {
        command: input.command,
        status: input.status,
        code: input.code ?? "none",
        count: 1,
        latencyMs: boundedDuration(input.latencyMs),
      })
      if (input.status === "error") observe("command_errors", 1)
      if (input.command === "delete_stream" && input.code === "close_required") {
        observe("close_required", 1)
        capture("workgraph.stream_lifecycle", { operation: "delete", outcome: "close_required", count: 1 })
      }
      if (input.command === "delete_stream" && input.status === "ok") {
        capture("workgraph.stream_lifecycle", { operation: "delete", outcome: "deleted", count: 1 })
      }
      if (input.command === "close_stream") {
        capture("workgraph.stream_lifecycle", {
          operation: "close",
          outcome: input.status === "ok" ? "closed" : "failed",
          count: 1,
        })
      }
    },
    reconciliation(
      input: Readonly<{
        trigger?: WorkGraphReconciliationTrigger
        outcome: "succeeded" | "failed"
        latencyMs: number
        lagMs: number
        claimed: number
        running: number
        settled: number
        failed: number
      }>,
    ) {
      capture("workgraph.reconciliation", {
        trigger: input.trigger ?? "cron",
        outcome: input.outcome,
        latencyMs: boundedDuration(input.latencyMs),
        lagMs: boundedDuration(input.lagMs),
        claimed: boundedCount(input.claimed),
        running: boundedCount(input.running),
        settled: boundedCount(input.settled),
        failed: boundedCount(input.failed),
      })
      if (input.outcome === "failed") observe("reconcile_failures", 1)
      observe("lag", input.lagMs)
    },
    queue(
      input: Readonly<{
        kind: "run" | "source_plan" | "session_intake"
        backlog: number
        oldestAgeMs: number
        failed: number
        retried: number
        expiredRecoveries: number
        activeLeaseAgeMs: number
      }>,
    ) {
      capture("workgraph.queue", {
        kind: input.kind,
        backlog: boundedCount(input.backlog),
        oldestAgeMs: boundedDuration(input.oldestAgeMs),
        failed: boundedCount(input.failed),
        retried: boundedCount(input.retried),
        expiredRecoveries: boundedCount(input.expiredRecoveries),
        activeLeaseAgeMs: boundedDuration(input.activeLeaseAgeMs),
      })
      observe("backlog", input.backlog)
      observe("lag", input.oldestAgeMs)
      observe("expired_lease_recoveries", input.expiredRecoveries)
      if (input.kind === "source_plan") observe("generation_failures", input.failed)
    },
    connector(
      input: Readonly<{
        surface: "source_view" | "webhook" | "connection_broker"
        outcome: "healthy" | "failed" | "auth_failed"
        latencyMs: number
        status: number
      }>,
    ) {
      capture("workgraph.connector", {
        surface: input.surface,
        outcome: input.outcome,
        latencyMs: boundedDuration(input.latencyMs),
        status: boundedStatus(input.status),
        count: 1,
      })
      if (input.outcome === "auth_failed") observe("connector_auth_failures", 1)
    },
    workspace(
      input: Readonly<{
        operation: "provision" | "launch" | "cancel" | "finalize" | "release" | "cleanup"
        outcome: "succeeded" | "pending" | "rejected" | "failed"
        latencyMs?: number
        count?: number
      }>,
    ) {
      capture("workgraph.workspace", {
        operation: input.operation,
        outcome: input.outcome,
        ...(input.latencyMs === undefined ? {} : { latencyMs: boundedDuration(input.latencyMs) }),
        count: boundedCount(input.count ?? 1),
      })
      if (input.outcome === "failed") observe("workspace_failures", input.count ?? 1)
    },
  }
}

export function instrumentWorkGraphCommands<
  Service extends Readonly<{
    execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult>
  }>,
>(service: Service, telemetry: WorkGraphOperationalReporter, now: () => number = Date.now): Service {
  return {
    ...service,
    async execute(context, request) {
      const startedAt = now()
      try {
        const result = await service.execute(context, request)
        telemetry.command({
          command: request.command.type,
          status: result.ok ? "ok" : "error",
          ...(!result.ok ? { code: result.error.code } : {}),
          latencyMs: now() - startedAt,
        })
        return result
      } catch (error) {
        telemetry.command({
          command: request.command.type,
          status: "error",
          code: "internal_error",
          latencyMs: now() - startedAt,
        })
        throw error
      }
    },
  }
}

export function workGraphHttpTelemetry(
  telemetry: WorkGraphOperationalReporter,
  now: () => number = Date.now,
): MiddlewareHandler {
  return async (context, next) => {
    const path = new URL(context.req.url).pathname
    const startedAt = now()
    await next()
    const latencyMs = now() - startedAt
    // The `/changes` long-poll — and the cursor telemetry derived from its
    // response envelope — is gone. Live sync is now the
    // `workgraph.changed` bus doorbell, which has no HTTP response to classify.
    const surface = path.includes("/webhooks/")
      ? "webhook"
      : path.includes("/source-views")
        ? "source_view"
        : path.includes("/connection-operation")
          ? "connection_broker"
          : undefined
    if (!surface) return
    telemetry.connector({
      surface,
      outcome:
        context.res.status === 401 || context.res.status === 403
          ? "auth_failed"
          : context.res.ok
            ? "healthy"
            : "failed",
      latencyMs,
      status: context.res.status,
    })
  }
}

function monitor(
  name: WorkGraphMonitorName,
  signal: WorkGraphMonitor["signal"],
  configured: string | undefined,
  threshold: number,
  windowMs: number,
  severity: WorkGraphMonitor["severity"],
): WorkGraphMonitor {
  return { name, signal, threshold: positive(configured, threshold), windowMs, severity }
}

function positive(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function boundedCount(value: number) {
  return Math.max(0, Math.min(1_000_000, Math.floor(Number.isFinite(value) ? value : 0)))
}

function boundedDuration(value: number) {
  return Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(Number.isFinite(value) ? value : 0)))
}

function boundedStatus(value: number) {
  return Math.max(0, Math.min(599, Math.floor(Number.isFinite(value) ? value : 0)))
}
