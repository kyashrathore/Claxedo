import type { SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "./sqlite/database"
import { subagentRunRevision, subagentStatusAdvances } from "./subagent-status"
import { subagentWakeStates } from "./subagent-wakes"

export function listSubagentRows(db: SqliteDatabase, parentSessionId: string) {
  const rows = db
    .prepare<Record<string, string | number | null>>(
      `
    SELECT *
    FROM session_subagent
    WHERE parent_session_id = ?
    ORDER BY created_at, subagent_key
  `,
    )
    .all(parentSessionId)
  const edges = db
    .prepare<{
    subagent_key: string
    tool_call_id: string
    role: "spawn" | "interaction"
    revision: number
  }>(
      `
    SELECT subagent_key, tool_call_id, role, revision
    FROM session_subagent_tool_call
    WHERE parent_session_id = ?
    ORDER BY created_at, tool_call_id
  `,
    )
    .all(parentSessionId)
  const wakes = subagentWakeStates(db, parentSessionId)
  return rows.map((row) => ({
    parentSessionId,
    subagentKey: String(row.subagent_key),
    revision: Number(row.revision),
    ...(typeof row.run_revision === "number" ? { runRevision: row.run_revision } : {}),
    ...(row.mode ? { mode: String(row.mode) } : {}),
    ...(row.status ? { status: String(row.status) } : {}),
    ...(row.label ? { label: String(row.label) } : {}),
    ...(row.subagent_type ? { subagentType: String(row.subagent_type) } : {}),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.provider_kind ? { providerKind: String(row.provider_kind) } : {}),
    ...(row.provider_id ? { providerId: String(row.provider_id) } : {}),
    ...(row.child_session_id ? { childSessionId: String(row.child_session_id) } : {}),
    ...(typeof row.attention === "number" ? { attention: row.attention } : {}),
    ...(wakes.has(String(row.subagent_key)) ? { wake: wakes.get(String(row.subagent_key)) } : {}),
    transcript: {
      kind: String(row.transcript_kind),
      ...(row.transcript_ref ? { ref: String(row.transcript_ref) } : {}),
    },
    toolCallEdges: edges
      .filter((edge) => edge.subagent_key === row.subagent_key)
      .map((edge) => ({ toolCallId: edge.tool_call_id, role: edge.role, revision: edge.revision })),
  }))
}

export function persistSubagentEvent(db: SqliteDatabase, parentSessionId: string, event: SubagentUpdatedEvent, startsNewRun: boolean) {
  const now = Date.now()
  db
    .prepare(
      `
    INSERT OR IGNORE INTO session_subagent (
      parent_session_id, subagent_key, revision, status, transcript_kind, created_at, updated_at
    ) VALUES (?, ?, 0, 'pending', 'none', ?, ?)
  `,
    )
    .run(parentSessionId, event.subagentKey, now, now)
  db
    .prepare(
      `
    UPDATE session_subagent
    SET revision = MAX(revision, ?), updated_at = ?
    WHERE parent_session_id = ? AND subagent_key = ?
  `,
    )
    .run(event.revision, now, parentSessionId, event.subagentKey)
  for (const [field, column] of [
    ["mode", "mode"],
    ["label", "label"],
    ["subagentType", "subagent_type"],
    ["description", "description"],
    ["attention", "attention"],
  ] as const) {
    const value = event[field]
    if (value === undefined) continue
    db
      .prepare(
        `
      UPDATE session_subagent
      SET ${column} = ?, ${column}_revision = ?
      WHERE parent_session_id = ? AND subagent_key = ? AND ${column}_revision < ?
    `,
      )
      .run(value, event.revision, parentSessionId, event.subagentKey, event.revision)
  }
  if (event.status !== undefined && (event.runRevision === undefined || event.runRevision >= (subagentRunRevision(db, parentSessionId, event.subagentKey) ?? 0))) {
    const current = db
      .prepare<{ status: string; status_revision: number }>(
        `
      SELECT status, status_revision
      FROM session_subagent
      WHERE parent_session_id = ? AND subagent_key = ?
    `,
      )
      .get(parentSessionId, event.subagentKey)
    if (!current) throw new Error("missing session_subagent row")
    if (subagentStatusAdvances(current, { status: event.status, revision: event.revision }, startsNewRun)) {
      db
        .prepare(
          `
        UPDATE session_subagent
        SET status = ?, status_revision = MAX(status_revision, ?)
        WHERE parent_session_id = ? AND subagent_key = ?
      `,
        )
        .run(event.status, event.revision, parentSessionId, event.subagentKey)
    }
    if (event.revision > current.status_revision) {
      db
        .prepare(
          `
        UPDATE session_subagent
        SET status_revision = ?
        WHERE parent_session_id = ? AND subagent_key = ?
      `,
        )
        .run(event.revision, parentSessionId, event.subagentKey)
    }
  }
  for (const [field, column] of [
    ["providerKind", "provider_kind"],
    ["providerId", "provider_id"],
    ["childSessionId", "child_session_id"],
  ] as const) {
    const value = event[field]
    if (value === undefined) continue
    db
      .prepare(
        `
      UPDATE session_subagent
      SET ${column} = ?, ${column}_revision = ?
      WHERE parent_session_id = ? AND subagent_key = ? AND ${column} IS NULL
    `,
      )
      .run(value, event.revision, parentSessionId, event.subagentKey)
  }
  if (event.transcript) {
    db
      .prepare(
        `
      UPDATE session_subagent
      SET transcript_kind = ?, transcript_ref = ?, transcript_revision = ?
      WHERE parent_session_id = ? AND subagent_key = ? AND transcript_revision < ?
    `,
      )
      .run(
        event.transcript.kind,
        event.transcript.ref ?? null,
        event.revision,
        parentSessionId,
        event.subagentKey,
        event.revision,
      )
  }
  if (event.toolCallId && event.toolCallRole) {
    db
      .prepare(
        `
      INSERT OR IGNORE INTO session_subagent_tool_call (
        parent_session_id, subagent_key, tool_call_id, role, revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(parentSessionId, event.subagentKey, event.toolCallId, event.toolCallRole, event.revision, now)
  }
}
