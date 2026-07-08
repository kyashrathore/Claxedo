import { ClaxedoDB } from "./storage/db"

export type ChannelRunAuditInput = {
  sessionId: string
  channel: string
  externalUserId: string
  threadKey: string
  workspaceId?: string | null
  cost?: number | null
  createdAt?: number
}

export type ChannelRunAuditRecord = Required<Pick<ChannelRunAuditInput,
  "sessionId" | "channel" | "externalUserId" | "threadKey"
>> & {
  workspaceId: string | null
  cost: number | null
  createdAt: number
}

type Row = Record<string, unknown>

function row(input: unknown): Row | undefined {
  return input && typeof input === "object" ? input as Row : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function record(input: unknown): ChannelRunAuditRecord | undefined {
  const hit = row(input)
  const sessionId = text(hit?.session_id)
  const channel = text(hit?.channel)
  const externalUserId = text(hit?.external_user_id)
  const threadKey = text(hit?.thread_key)
  const createdAt = num(hit?.created_at)
  if (!sessionId || !channel || !externalUserId || !threadKey || createdAt === undefined) return
  return {
    sessionId,
    channel,
    externalUserId,
    threadKey,
    workspaceId: text(hit?.workspace_id) ?? null,
    cost: num(hit?.cost) ?? null,
    createdAt,
  }
}

export async function recordChannelRunAudit(input: ChannelRunAuditInput) {
  ClaxedoDB.raw().prepare(`
    INSERT INTO claxedo_channel_run_audit (
      session_id,
      channel,
      external_user_id,
      thread_key,
      workspace_id,
      cost,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      channel = excluded.channel,
      external_user_id = excluded.external_user_id,
      thread_key = excluded.thread_key,
      workspace_id = excluded.workspace_id,
      cost = excluded.cost,
      created_at = excluded.created_at
  `).run(
    input.sessionId,
    input.channel,
    input.externalUserId,
    input.threadKey,
    input.workspaceId ?? null,
    input.cost ?? null,
    input.createdAt ?? Date.now(),
  )
}

export async function channelRunAudit(input: { sessionId: string }) {
  return record(ClaxedoDB.raw().prepare(`
    SELECT *
    FROM claxedo_channel_run_audit
    WHERE session_id = ?
  `).get(input.sessionId))
}

export async function channelRunAudits(input: {
  channel?: string
  externalUserId?: string
  threadKey?: string
  workspaceId?: string
} = {}) {
  const where = [
    input.channel ? "channel = ?" : undefined,
    input.externalUserId ? "external_user_id = ?" : undefined,
    input.threadKey ? "thread_key = ?" : undefined,
    input.workspaceId ? "workspace_id = ?" : undefined,
  ].filter((item): item is string => !!item)
  return ClaxedoDB.raw().prepare(`
    SELECT *
    FROM claxedo_channel_run_audit
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
  `).all(...[
    input.channel,
    input.externalUserId,
    input.threadKey,
    input.workspaceId,
  ].filter((item): item is string => !!item)).flatMap((item) => record(item) ?? [])
}
