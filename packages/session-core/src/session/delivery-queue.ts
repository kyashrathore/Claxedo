import type { AgentMessageAuthor, PromptFormat, PromptInput } from "@claxedo/agent-runtime-contract"
import { actorKind } from "../stored-columns"
import type { SessionRequestProvenance, SessionWorkspaceAuthority } from "../session-access-policy"
import type { SqliteDatabase } from "../sqlite/database"

/**
 * A prompt admitted for a session that was already running a turn, waiting for
 * that turn to end.
 *
 * The session delivery owner reads these rows across request completion and
 * restart. `seq` is a durable control identity; actor and authority travel with
 * the payload so recovery reacquires the original requester's turn authority.
 */
export type QueuedPromptAttempt = {
  mode: "start" | "steer"
  operationId: string
  state: "dispatching" | "accepted" | "unknown" | "rejected"
  message?: string
}

export type QueuedPromptRecord = {
  authority?: SessionWorkspaceAuthority
  held?: boolean
  steering?: QueuedPromptAttempt
  sessionId: string
  seq: number
  messageId?: string
  parts: PromptInput["parts"]
  agent?: string
  model?: { providerID?: string; modelID?: string }
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  serviceTier?: string
  permissionMode?: string
  delivery: "steer" | "queue"
  actor?: { actorId: string; actorKind: "human" | "agent" }
  author?: AgentMessageAuthor
  /**
   * How the request that queued this reached the runtime. Read back with
   * `actor`/`authority` as the origin the delayed turn runs under; a row
   * written before it was recorded has none and is never re-issued.
   */
  provenance?: SessionRequestProvenance
  /** The deferred turn grant a relayed requester queued this under; see `SessionTurnOrigin`. */
  grant?: string
  queuedAt: number
}

type QueuedPromptRow = {
  authority_json: string | null
  origin_provenance: string | null
  turn_grant: string | null
  service_tier: string | null
  held: number
  steering_json: string | null
  session_id: string
  seq: number
  message_id: string | null
  parts_json: string
  agent: string | null
  model_provider_id: string | null
  model_id: string | null
  tools_json: string | null
  format_json: string | null
  system: string | null
  variant: string | null
  permission_mode: string | null
  delivery: string
  actor_id: string | null
  actor_kind: string | null
  author_id: string | null
  author_name: string | null
  author_avatar_url: string | null
  author_kind: string | null
  queued_at: number
}

function queuedPrompt(row: QueuedPromptRow): QueuedPromptRecord {
  const parts: QueuedPromptRecord["parts"] = JSON.parse(row.parts_json)
  const tools: Record<string, boolean> | undefined = row.tools_json === null ? undefined : JSON.parse(row.tools_json)
  const format: PromptFormat | undefined = row.format_json === null ? undefined : JSON.parse(row.format_json)
  const kind = actorKind(row.actor_kind)
  const authorKind = actorKind(row.author_kind)
  return {
    sessionId: row.session_id,
    seq: row.seq,
    ...(row.authority_json ? { authority: JSON.parse(row.authority_json) } : {}),
    ...(row.origin_provenance === "loopback-direct" || row.origin_provenance === "relay-replayed"
      ? { provenance: row.origin_provenance }
      : {}),
    ...(row.turn_grant === null ? {} : { grant: row.turn_grant }),
    ...(row.held ? { held: true } : {}),
    ...(row.steering_json ? { steering: JSON.parse(row.steering_json) } : {}),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    parts,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.model_provider_id === null && row.model_id === null ? {} : {
      model: {
        ...(row.model_provider_id === null ? {} : { providerID: row.model_provider_id }),
        ...(row.model_id === null ? {} : { modelID: row.model_id }),
      },
    }),
    ...(tools === undefined ? {} : { tools }),
    ...(format === undefined ? {} : { format }),
    ...(row.system === null ? {} : { system: row.system }),
    ...(row.variant === null ? {} : { variant: row.variant }),
    ...(row.service_tier === null ? {} : { serviceTier: row.service_tier }),
    ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
    delivery: row.delivery === "steer" ? "steer" : "queue",
    ...(row.actor_id === null || kind === undefined ? {} : { actor: { actorId: row.actor_id, actorKind: kind } }),
    ...(row.author_id === null || row.author_name === null || authorKind === undefined ? {} : {
      author: {
        id: row.author_id,
        name: row.author_name,
        ...(row.author_avatar_url === null ? {} : { avatarUrl: row.author_avatar_url }),
        kind: authorKind,
      },
    }),
    queuedAt: row.queued_at,
  }
}

/** The session delivery owner is the only writer; the store owns the table's schema and hands this its database. */
export class DeliveryQueue {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly recordAuthor: (sessionId: string, actorId?: string) => void,
  ) {}

  /**
   * Persist a prompt waiting for this session's running turn to end.
   *
   * The lease and busy-session recovery above deliberately do not touch these
   * rows: a turn from the previous runtime cannot be resumed, but a prompt that
   * never reached one still has to run.
   */
  queuePrompt(input: Omit<QueuedPromptRecord, "seq" | "queuedAt" | "held" | "steering">): QueuedPromptRecord {
    return this.db.transaction(() => {
      if (input.messageId) {
        const existing = this.db.prepare<QueuedPromptRow>(
          "SELECT * FROM runtime_delivery WHERE session_id = ? AND message_id = ? ORDER BY seq LIMIT 1",
        ).get(input.sessionId, input.messageId)
        if (existing) return queuedPrompt(existing)
      }
      const sequence = this.db.prepare<{ seq: number }>(`
        INSERT INTO runtime_delivery_sequence (session_id, seq) VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET seq = seq + 1
        RETURNING seq
      `).get(input.sessionId)
      if (!sequence) throw new Error("missing queued prompt seq row")
      const seq = sequence.seq
      const record: QueuedPromptRecord = { ...input, seq, queuedAt: Date.now() }
      this.db
        .prepare(
          `
        INSERT INTO runtime_delivery (
          session_id,
          seq,
          message_id,
          parts_json,
          agent,
          model_provider_id,
          model_id,
          tools_json,
          format_json,
          system,
          variant,
          permission_mode,
          delivery,
          actor_id,
          actor_kind,
          author_id,
          author_name,
          author_avatar_url,
          author_kind,
          queued_at,
          authority_json,
          origin_provenance,
          turn_grant,
          service_tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          record.sessionId,
          record.seq,
          record.messageId ?? null,
          JSON.stringify(record.parts),
          record.agent ?? null,
          record.model?.providerID ?? null,
          record.model?.modelID ?? null,
          record.tools === undefined ? null : JSON.stringify(record.tools),
          record.format === undefined ? null : JSON.stringify(record.format),
          record.system ?? null,
          record.variant ?? null,
          record.permissionMode ?? null,
          record.delivery,
          record.actor?.actorId ?? null,
          record.actor?.actorKind ?? null,
          record.author?.id ?? null,
          record.author?.name ?? null,
          record.author?.avatarUrl ?? null,
          record.author?.kind ?? null,
          record.queuedAt,
          record.authority ? JSON.stringify(record.authority) : null,
          record.provenance ?? null,
          record.grant ?? null,
          record.serviceTier ?? null,
        )
      this.recordAuthor(record.sessionId, record.actor?.actorId)
      return record
    })
  }

  claimQueuedPromptDelivery(sessionId: string, seq: number, operationId: string, mode: "start" | "steer"): boolean {
    return this.db.prepare(`UPDATE runtime_delivery SET steering_json = ?, message_id = COALESCE(message_id, ?)
      WHERE session_id = ? AND seq = ?
      AND (? != 'start' OR (held = 0 AND NOT EXISTS (
        SELECT 1 FROM runtime_delivery earlier
        WHERE earlier.session_id = runtime_delivery.session_id AND earlier.seq < runtime_delivery.seq
        AND ((earlier.held = 0 AND (earlier.steering_json IS NULL OR json_extract(earlier.steering_json, '$.state') = 'rejected'))
          OR (json_extract(earlier.steering_json, '$.mode') = 'start'
            AND json_extract(earlier.steering_json, '$.state') IN ('dispatching', 'unknown')))
      )))
      AND (steering_json IS NULL OR json_extract(steering_json, '$.state') = 'rejected')`)
      .run(JSON.stringify({ operationId, state: "dispatching", mode }), `msg_${crypto.randomUUID()}`, sessionId, seq, mode).changes === 1
  }

  settleQueuedPromptDelivery(sessionId: string, seq: number, steering: QueuedPromptAttempt): boolean {
    return this.db.prepare(`UPDATE runtime_delivery SET steering_json = ?
      WHERE session_id = ? AND seq = ? AND
      json_extract(steering_json, '$.operationId') = ? AND json_extract(steering_json, '$.state') = 'dispatching'`)
      .run(JSON.stringify(steering), sessionId, seq, steering.operationId).changes === 1
  }

  /** Called only when no operation of a previous runtime can still be dispatching. */
  settleOrphanedDispatches() {
    this.db.prepare(`UPDATE runtime_delivery
      SET steering_json = json_set(steering_json, '$.state', 'unknown', '$.message', ?)
      WHERE json_extract(steering_json, '$.state') = 'dispatching'`)
      .run("The runtime restarted before this input's delivery was confirmed")
  }

  deleteQueuedPrompt(sessionId: string, seq: number) {
    return this.db.prepare(`DELETE FROM runtime_delivery WHERE session_id = ? AND seq = ?
      AND (steering_json IS NULL OR json_extract(steering_json, '$.state') IN ('rejected', 'unknown'))`).run(sessionId, seq).changes === 1
  }

  /** A steered row whose message the transcript now holds: the provider took it in, so nothing is left to deliver. */
  retireSteeredPrompt(sessionId: string, messageId: string): boolean {
    return this.db.prepare(`DELETE FROM runtime_delivery WHERE session_id = ? AND message_id = ?
      AND json_extract(steering_json, '$.mode') = 'steer'
      AND json_extract(steering_json, '$.state') != 'rejected'`)
      .run(sessionId, messageId).changes === 1
  }

  replaceQueuedPromptParts(sessionId: string, seq: number, parts: QueuedPromptRecord["parts"]): boolean {
    return this.db
      .prepare(`UPDATE runtime_delivery SET parts_json = ?, held = 0 WHERE session_id = ? AND seq = ?
        AND (steering_json IS NULL OR json_extract(steering_json, '$.state') = 'rejected')`)
      .run(JSON.stringify(parts), sessionId, seq).changes === 1
  }

  setQueuedPromptHeld(sessionId: string, seq: number, held: boolean): boolean {
    return this.db.prepare(`UPDATE runtime_delivery SET held = ? WHERE session_id = ? AND seq = ?
      AND (steering_json IS NULL OR json_extract(steering_json, '$.state') = 'rejected')`)
      .run(held ? 1 : 0, sessionId, seq).changes === 1
  }

  completeQueuedPrompt(sessionId: string, seq: number, operationId: string): boolean {
    return this.db.prepare(`DELETE FROM runtime_delivery WHERE session_id = ? AND seq = ?
      AND json_extract(steering_json, '$.operationId') = ?
      AND json_extract(steering_json, '$.mode') = 'start'
      AND json_extract(steering_json, '$.state') = 'dispatching'`)
      .run(sessionId, seq, operationId).changes === 1
  }

  listQueuedPrompts(): QueuedPromptRecord[] {
    return this.db
      .prepare<QueuedPromptRow>(`
      SELECT
        session_id,
        seq,
        message_id,
        parts_json,
        agent,
        model_provider_id,
        model_id,
        tools_json,
        format_json,
        system,
        variant,
        permission_mode,
        delivery,
        actor_id,
        actor_kind,
        author_id,
        author_name,
        author_avatar_url,
        author_kind,
        queued_at,
        steering_json,
        authority_json,
        origin_provenance,
        turn_grant,
        service_tier,
        held
      FROM runtime_delivery
      ORDER BY queued_at, session_id, seq
    `)
      .all()
      .map(queuedPrompt)
  }

  forgetSession(sessionId: string) {
    this.db.prepare("DELETE FROM runtime_delivery WHERE session_id = ?").run(sessionId)
  }
}
