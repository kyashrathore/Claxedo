import { assertLocationInScope, type WorkspaceScope } from "./scope.js"
import { asArrayOrUndefined as arr, asNumber as num, asRecord as rec, asString as str } from "@claxedo/helpers/guards"
import { tokenUsage, type PromptAttachment, type SessionMessage, type SessionSummary } from "./session-types.js"

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
    id: str(row.id) ?? "",
    ...(title === undefined ? {} : { title }),
    ...(parentID === undefined ? {} : { parentID }),
    directory: scope.directory,
    createdAt: num(time?.created) ?? 0,
    updatedAt: num(time?.updated) ?? 0,
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
    id: str(row.id) ?? "",
    type: str(row.type) ?? "",
    createdAt: num(time?.created) ?? 0,
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
