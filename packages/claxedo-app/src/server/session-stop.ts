import type { RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { isRecoveryOutcome, parseRecoveryOutcome, parseRecoveryTarget, turnStopped } from "@claxedo/agent-runtime-contract"
import { readField, readString } from "@claxedo/helpers/readers"
import { contractMismatch, responseError, ServerError } from "./errors"
import { sessionEndpoint } from "./session-context"
import { jsonInit, type RuntimeRoute, type Transport } from "./transport"
import type { BackgroundTaskStop } from "./status-types"
import type { SessionLocation } from "./types"

const REFUSAL_CLASSES: Readonly<Record<string, ServerError["class"]>> = {
  generation_conflict: "conflict",
  intent_conflict: "conflict",
  scope_changed: "conflict",
  unauthorized: "auth",
}

function stopRefused(outcome: RecoveryOutcome): ServerError {
  if (outcome.kind === "refused") {
    return new ServerError({ class: REFUSAL_CLASSES[outcome.refusal.kind] ?? "internal", message: outcome.refusal.message, code: outcome.refusal.kind })
  }
  const error = outcome.operation.initiatingError ?? outcome.operation.cleanupErrors[0]
  return new ServerError({
    class: "internal",
    message: error?.message ?? `The turn did not stop (${outcome.operation.state})`,
    code: error?.code ?? outcome.operation.state,
  })
}

export async function cancelRunningTurn(transport: Transport, where: RuntimeRoute, ref: SessionLocation): Promise<void> {
  const path = sessionEndpoint(ref, "/recovery")
  const inspected = await transport.runtimeJson(where, path)
  if (isRecoveryOutcome(inspected)) throw stopRefused(inspected)
  const running = readField(inspected, "target")
  if (!running) return
  const target = parseRecoveryTarget(running)
  if (target.scope !== "turn") throw contractMismatch("recovery target")
  const outcome = parseRecoveryOutcome(await transport.runtimeJson(where, path, jsonInit("POST", {
    requestId: `stop:${crypto.randomUUID()}`,
    action: "cancel_turn",
    target,
    scopeRevision: target.ownerGeneration,
    attempt: 1,
  })))
  if (!turnStopped(outcome)) throw stopRefused(outcome)
}

export async function stopBackgroundTask(transport: Transport, where: RuntimeRoute, ref: SessionLocation, toolCallId: string): Promise<BackgroundTaskStop> {
  const response = await transport.runtime(where, sessionEndpoint(ref, "/background-task/stop"), jsonInit("POST", { toolCallId }))
  if (response.ok) return { ok: true }
  if (response.status !== 404) throw await responseError(response, "Stop background task")
  return { ok: false, status: "not_found", message: readString(await response.json(), "message") ?? "The task is not running" }
}

export async function readStopsBackgroundTasks(transport: Transport, where: RuntimeRoute, ref: SessionLocation): Promise<boolean> {
  return readField(await transport.runtimeJson(where, sessionEndpoint(ref, "/capabilities")), "backgroundTasks") === true
}
