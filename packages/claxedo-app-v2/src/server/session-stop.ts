import type { RecoveryOutcome, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { isRecoveryOutcome, turnStopped } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import { sessionEndpoint } from "./session-context"
import { jsonInit, type RuntimeRoute, type Transport } from "./transport"
import type { SessionRef } from "./types"

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

export async function stopTurn(transport: Transport, where: RuntimeRoute, ref: SessionRef): Promise<void> {
  const path = sessionEndpoint(ref, "/recovery")
  const inspected = await transport.runtimeJson<{ target?: RecoveryTurnTarget } | RecoveryOutcome>(where, path)
  if (isRecoveryOutcome(inspected)) throw stopRefused(inspected)
  const target = inspected.target
  if (!target) return
  const outcome = await transport.runtimeJson<RecoveryOutcome>(where, path, jsonInit("POST", {
    requestId: `stop:${crypto.randomUUID()}`,
    action: "cancel_turn",
    target,
    scopeRevision: target.ownerGeneration,
    attempt: 1,
  }))
  if (!turnStopped(outcome)) throw stopRefused(outcome)
}
