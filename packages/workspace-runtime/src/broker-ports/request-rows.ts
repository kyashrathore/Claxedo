import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import type { PendingRequest, RequestAnswer, RequestScope } from "@claxedo/harness/contract"
import type { BrokerEvent } from "@claxedo/harness/broker"
import type { RuntimeStore, SqliteDatabase } from "../store"
import type { BrokerEventDelivery } from "./delivery"
import { parseStoredAnswer, parseStoredRequest, parseStoredStart } from "./stored-values"

type AnswerRow = { broker_answer_json: string | null }
type PendingRow = {
  session_id: string
  broker_request_json: string
  broker_upstream_session_id: string | null
  broker_start_json: string | null
  created_at: number
}

function table(request: PendingRequest["request"]): "pending_permission" | "pending_question" {
  return request.kind === "permission" ? "pending_permission" : "pending_question"
}

function readAnswerRow(db: SqliteDatabase, sessionId: string, requestId: string): AnswerRow | undefined {
  for (const name of ["pending_permission", "pending_question"] as const) {
    const row = db.prepare<AnswerRow>(
      `SELECT broker_answer_json FROM ${name} WHERE session_id = ? AND id = ?`,
    ).get(sessionId, requestId)
    if (row) return row
  }
  return undefined
}

function replyEvent(pending: PendingRequest, answer: RequestAnswer): AgentPresentationEvent {
  const sessionID = pending.sessionId
  const requestID = pending.request.requestId
  if (pending.request.kind === "permission") {
    const reply = answer.kind === "permission"
      ? answer.decision === "allow_always" ? "always" : answer.decision === "allow_once" ? "once" : "reject"
      : "reject"
    return {
      id: `permission.replied:${sessionID}:${requestID}`,
      type: "permission.replied",
      properties: { sessionID, requestID, reply },
    }
  }
  if (answer.kind === "answers") {
    return {
      id: `question.replied:${sessionID}:${requestID}`,
      type: "question.replied",
      properties: { sessionID, requestID, answers: answer.answers.map((part) => [...part]) },
    }
  }
  return {
    id: `question.rejected:${sessionID}:${requestID}`,
    type: "question.rejected",
    properties: { sessionID, requestID },
  }
}

export class BrokerRequestRows {
  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  readAnswer(sessionId: string, requestId: string): RequestAnswer | undefined {
    const row = readAnswerRow(this.store.brokerDatabase(), sessionId, requestId)
    return row?.broker_answer_json ? parseStoredAnswer(row.broker_answer_json) : undefined
  }

  readPending(scope: RequestScope): readonly PendingRequest[] {
    const condition = "sessionId" in scope ? "p.session_id = ?" : "COALESCE(s.directory, start.directory) = ?"
    const value = "sessionId" in scope ? scope.sessionId : scope.directory
    return ["pending_permission", "pending_question"].flatMap((name) =>
      this.store.brokerDatabase().prepare<PendingRow>(`
        SELECT p.session_id, p.broker_request_json, p.broker_upstream_session_id,
          p.broker_start_json, p.created_at
        FROM ${name} p
        LEFT JOIN session s ON s.id = p.session_id
        LEFT JOIN session_start start ON start.session_id = p.session_id
        WHERE ${condition} AND p.status = 'pending' AND p.broker_request_json IS NOT NULL
        ORDER BY p.created_at
      `).all(value).map((row) => ({
        sessionId: row.session_id,
        request: parseStoredRequest(row.broker_request_json),
        askedAt: row.created_at,
        ...(row.broker_upstream_session_id ? { upstreamSessionId: row.broker_upstream_session_id } : {}),
        ...(row.broker_start_json ? { start: parseStoredStart(row.broker_start_json) } : {}),
      })),
    ).sort((a, b) => a.askedAt - b.askedAt)
  }

  async publish(event: BrokerEvent, pending?: PendingRequest): Promise<void> {
    if (!pending) {
      if (event.type !== "permission.auto-answered") throw new Error("Broker request metadata required")
      this.delivery.append(event.sessionId, {
          id: `runtime.diagnostic:${event.sessionId}:${event.requestId}`,
          type: "runtime.diagnostic",
          properties: {
            sessionID: event.sessionId, code: "permission.auto-answered",
            message: event.requestId, severity: "info", details: { grantKey: event.grantKey },
          },
      })
      return
    }
    if (event.type === "permission.auto-answered") throw new Error("Automatic answer cannot publish a pending request")
    const published = this.store.brokerTransaction(() => {
      if (this.readAnswer(pending.sessionId, pending.request.requestId)) return false
      this.store.brokerAppendInside(pending.sessionId, event)
      this.store.brokerDatabase().prepare(`
        UPDATE ${table(pending.request)}
        SET broker_request_json = ?, broker_upstream_session_id = ?, broker_start_json = ?, created_at = ?
        WHERE session_id = ? AND id = ?
      `).run(
        JSON.stringify(pending.request), pending.upstreamSessionId ?? null,
        pending.start ? JSON.stringify(pending.start) : null, pending.askedAt,
        pending.sessionId, pending.request.requestId,
      )
      return true
    })
    if (published) this.delivery.broadcast(pending.sessionId, event)
  }

  async persistAnswer(
    pending: PendingRequest, answer: RequestAnswer, automatic: boolean, grantKey?: string,
  ): Promise<readonly AgentRuntimeEvent[]> {
    const published = this.store.brokerTransaction(() => {
      const db = this.store.brokerDatabase()
      const prior = readAnswerRow(db, pending.sessionId, pending.request.requestId)
      if (prior?.broker_answer_json) return false
      const name = table(pending.request)
      if (!prior) {
        if (pending.request.kind === "permission") {
          db.prepare(`INSERT INTO pending_permission
            (id, session_id, tool, patterns_json, metadata_json, always_json, options_json,
             status, created_at, updated_at, broker_request_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
            .run(pending.request.requestId, pending.sessionId, pending.request.permission.permission,
              JSON.stringify(pending.request.permission.patterns), JSON.stringify(pending.request.permission.metadata),
              JSON.stringify(pending.request.permission.always),
              pending.request.permission.options === undefined ? null : JSON.stringify(pending.request.permission.options),
              pending.askedAt, pending.askedAt, JSON.stringify(pending.request))
        } else {
          db.prepare(`INSERT INTO pending_question
            (id, session_id, questions_json, status, created_at, updated_at, broker_request_json)
            VALUES (?, ?, '[]', 'pending', ?, ?, ?)`)
            .run(pending.request.requestId, pending.sessionId, pending.askedAt, pending.askedAt,
              JSON.stringify(pending.request))
        }
      }
      if (grantKey) this.store.brokerPersistGrantInside(pending.sessionId, grantKey)
      if (prior) this.store.brokerAppendInside(pending.sessionId, replyEvent(pending, answer))
      db.prepare(`UPDATE ${name} SET status = 'answered', broker_answer_json = ?, broker_automatic = ?, updated_at = ?
        WHERE session_id = ? AND id = ? AND broker_answer_json IS NULL`)
        .run(JSON.stringify(answer), automatic ? 1 : 0, Date.now(), pending.sessionId, pending.request.requestId)
      return !!prior
    })
    if (published) this.delivery.broadcast(pending.sessionId, replyEvent(pending, answer))
    return []
  }
}
