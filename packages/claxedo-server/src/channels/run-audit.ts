import { and, desc, eq } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db/db"
import { ClaxedoChannelRunAuditTable } from "../platform/db/channel-run-audit.sql"
import { ClaxedoChannelStateTable } from "../platform/db/channel-delivery.sql"

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

const THREAD_SESSION_KEY_PREFIX = "channel_session.active:"

function record(row: typeof ClaxedoChannelRunAuditTable.$inferSelect): ChannelRunAuditRecord {
  return {
    sessionId: row.session_id,
    channel: row.channel,
    externalUserId: row.external_user_id,
    threadKey: row.thread_key,
    workspaceId: row.workspace_id ?? null,
    cost: row.cost ?? null,
    createdAt: row.created_at,
  }
}

export async function recordChannelRunAudit(input: ChannelRunAuditInput) {
  const createdAt = input.createdAt ?? Date.now()
  ClaxedoDB.transaction((tx) => {
    tx.insert(ClaxedoChannelRunAuditTable).values({
      session_id: input.sessionId,
      channel: input.channel,
      external_user_id: input.externalUserId,
      thread_key: input.threadKey,
      workspace_id: input.workspaceId ?? null,
      cost: input.cost ?? null,
      created_at: createdAt,
    }).onConflictDoUpdate({
      target: ClaxedoChannelRunAuditTable.session_id,
      set: {
        channel: input.channel,
        external_user_id: input.externalUserId,
        thread_key: input.threadKey,
        workspace_id: input.workspaceId ?? null,
        cost: input.cost ?? null,
        created_at: createdAt,
      },
    }).run()
    tx.insert(ClaxedoChannelStateTable).values({
      key: `${THREAD_SESSION_KEY_PREFIX}${input.threadKey}`,
      value: input.sessionId,
      updated_at: createdAt,
    }).onConflictDoUpdate({
      target: ClaxedoChannelStateTable.key,
      set: { value: input.sessionId, updated_at: createdAt },
    }).run()
  })
}

export async function channelRunAudit(input: { sessionId: string }) {
  const row = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoChannelRunAuditTable)
      .where(eq(ClaxedoChannelRunAuditTable.session_id, input.sessionId))
      .get(),
  )
  return row ? record(row) : undefined
}

export async function channelRunAudits(input: {
  channel?: string
  externalUserId?: string
  threadKey?: string
  workspaceId?: string
} = {}) {
  const filters = [
    input.channel ? eq(ClaxedoChannelRunAuditTable.channel, input.channel) : undefined,
    input.externalUserId ? eq(ClaxedoChannelRunAuditTable.external_user_id, input.externalUserId) : undefined,
    input.threadKey ? eq(ClaxedoChannelRunAuditTable.thread_key, input.threadKey) : undefined,
    input.workspaceId ? eq(ClaxedoChannelRunAuditTable.workspace_id, input.workspaceId) : undefined,
  ].filter((item) => item !== undefined)
  return ClaxedoDB.use((db) =>
    db.select().from(ClaxedoChannelRunAuditTable)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(ClaxedoChannelRunAuditTable.created_at))
      .all(),
  ).map(record)
}

export async function channelThreadSession(input: { threadKey: string }) {
  const row = ClaxedoDB.use((db) =>
    db.select({ value: ClaxedoChannelStateTable.value }).from(ClaxedoChannelStateTable)
      .where(eq(ClaxedoChannelStateTable.key, `${THREAD_SESSION_KEY_PREFIX}${input.threadKey}`))
      .get(),
  )
  return row?.value && row.value.trim() ? row.value : undefined
}

export async function clearChannelThreadSession(input: { threadKey: string; sessionId?: string }) {
  const key = `${THREAD_SESSION_KEY_PREFIX}${input.threadKey}`
  ClaxedoDB.use((db) => db.delete(ClaxedoChannelStateTable).where(
    input.sessionId
      ? and(eq(ClaxedoChannelStateTable.key, key), eq(ClaxedoChannelStateTable.value, input.sessionId))
      : eq(ClaxedoChannelStateTable.key, key),
  ).run())
}
