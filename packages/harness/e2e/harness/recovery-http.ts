import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { RecoveryOperation, RecoveryOutcome, RecoveryRequest, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"

export type HttpReply<T> = { status: number; body: T }
export type RecoveryInspection = {
  sessionId: string
  target?: RecoveryTurnTarget
  facts: { execution: { value: string }; cleanup: { value: string }; persistence: { value: string } }
}

async function reply<T>(url: string, method: string, body?: unknown, caller?: string): Promise<HttpReply<T>> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(caller ? { "x-claxedo-caller-id": caller } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() as T }
}

function route(url: string, directory: string, sessionId: string, suffix = "") {
  const target = new URL(`/session/${encodeURIComponent(sessionId)}/recovery${suffix}`, url)
  target.searchParams.set("directory", directory)
  return target.toString()
}

export function inspectRecovery(url: string, directory: string, sessionId: string) {
  return reply<RecoveryInspection | RecoveryOutcome>(route(url, directory, sessionId), "GET")
}

export function submitRecovery(url: string, directory: string, sessionId: string, request: RecoveryRequest) {
  return reply<RecoveryOutcome>(route(url, directory, sessionId), "POST", request)
}

export function readRecovery(url: string, directory: string, sessionId: string, operationId: string) {
  return reply<RecoveryOutcome>(route(url, directory, sessionId, `/operations/${encodeURIComponent(operationId)}`), "GET")
}

export function stopRequest(target: RecoveryTurnTarget): RecoveryRequest {
  return { requestId: `e2e-stop-${randomUUID()}`, action: "cancel_turn", target, scopeRevision: target.ownerGeneration, attempt: 1 }
}

export function operation(reply: HttpReply<RecoveryOutcome>, state: RecoveryOperation["state"]): RecoveryOperation {
  assert.equal(reply.status, 200, `recovery operation HTTP status: ${JSON.stringify(reply.body)}`)
  assert.equal(reply.body.kind, "operation", `recovery operation body: ${JSON.stringify(reply.body)}`)
  if (reply.body.kind !== "operation") throw new Error("recovery response was not an operation")
  assert.equal(reply.body.operation.state, state, JSON.stringify(reply.body.operation))
  return reply.body.operation
}

export async function waitForTurnTarget(url: string, directory: string, sessionId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const inspected = await inspectRecovery(url, directory, sessionId)
    assert.equal(inspected.status, 200, `recovery inspection HTTP status: ${JSON.stringify(inspected.body)}`)
    if ("target" in inspected.body && inspected.body.target?.scope === "turn") return inspected.body.target
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Session ${sessionId} never exposed a running turn through recovery inspection`)
}
