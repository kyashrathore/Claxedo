import { assertLocationInScope, type WorkspaceScope } from "./scope.js"
import { asArrayOrUndefined as arr, asNumber as num, asRecord as rec, asString as str } from "@claxedo/helpers/guards"
import { tokenUsage, type PromptAttachment, type SessionMessage, type SessionSummary } from "./session-types.js"
import { OpenCodeRecordError } from "./errors.js"

export function engineTime(value: unknown, record: string, field: string): number {
  const at = num(value)
  if (at === undefined) throw new OpenCodeRecordError(record, field)
  return at
}

export function engineId(value: unknown, record: string): string {
  const id = str(value)
  if (!id) throw new OpenCodeRecordError(record, "id")
  return id
}

export function project(scope: WorkspaceScope, input: unknown): SessionSummary {
  const row = rec(input) ?? {}
  const time = rec(row.time)
  assertLocationInScope(scope, str(rec(row.location)?.directory))
  const title = str(row.title)
  const parentID = str(row.parentID)
  const tokens = tokenUsage(row.tokens)
  const idleAt = num(time?.idle)
  const outcome = row.outcome === "succeeded" || row.outcome === "failed" || row.outcome === "interrupted" ? row.outcome : undefined
  return {
    id: engineId(row.id, "a session"),
    ...(title === undefined ? {} : { title }),
    ...(parentID === undefined ? {} : { parentID }),
    directory: scope.directory,
    createdAt: engineTime(time?.created, "a session", "time.created"),
    updatedAt: engineTime(time?.updated, "a session", "time.updated"),
    ...(idleAt === undefined ? {} : { idleAt }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(tokens === undefined ? {} : { tokens }),
  }
}

export function projectMessage(input: unknown): SessionMessage {
  const row = rec(input) ?? {}
  const time = rec(row.time)
  const model = rec(row.model)
  const providerID = str(model?.providerID)
  const modelId = str(model?.id)
  const text = str(row.text)
  const agent = str(row.agent)
  const finish = str(row.finish)
  const content = arr(row.content)
  const metadata = rec(row.metadata)
  const completedAt = num(time?.completed)
  return {
    id: engineId(row.id, "a message"),
    type: str(row.type) ?? "",
    createdAt: engineTime(time?.created, "a message", "time.created"),
    ...(text === undefined ? {} : { text }),
    ...(agent === undefined ? {} : { agent }),
    ...(providerID && modelId ? { model: { providerID, id: modelId } } : {}),
    ...(content === undefined ? {} : { content }),
    ...(finish === undefined ? {} : { finish }),
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

export function fileAttachment(item: PromptAttachment) {
  return {
    uri: item.ref,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}

export function agentAttachment(item: PromptAttachment) {
  return {
    name: item.ref,
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}

export function skillAttachment(item: PromptAttachment) {
  return {
    id: item.ref,
    ...(item.mention === undefined ? {} : { mention: item.mention }),
  }
}
