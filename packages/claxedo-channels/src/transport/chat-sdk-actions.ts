import type { ApprovalDecision } from "../envelope"

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function text(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function bool(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined
}

function firstText(...input: unknown[]) {
  for (const item of input) {
    const value = text(item)
    if (value) return value
  }
}

function nested(input: Record<string, unknown> | undefined, key: string) {
  return record(input?.[key])
}

function decisionValue(input: Record<string, unknown>) {
  const value = firstText(
    input.decision,
    input.value,
    input.action,
    input.actionId,
    input.action_id,
    input.name,
    nested(input, "payload")?.decision,
    nested(input, "payload")?.value,
    nested(input, "data")?.decision,
    nested(input, "data")?.value,
  )?.toLowerCase()
  const explicit = bool(input.approved) ?? bool(nested(input, "payload")?.approved) ?? bool(nested(input, "data")?.approved)
  if (explicit !== undefined) return explicit
  if (!value) return
  if (/approve|allow|yes|once/.test(value)) return true
  if (/deny|reject|no/.test(value)) return false
}

function callId(input: Record<string, unknown>) {
  return firstText(
    input.callId,
    input.call_id,
    input.permissionId,
    input.permission_id,
    nested(input, "payload")?.callId,
    nested(input, "payload")?.call_id,
    nested(input, "payload")?.permissionId,
    nested(input, "payload")?.permission_id,
    nested(input, "data")?.callId,
    nested(input, "data")?.call_id,
    nested(input, "data")?.permissionId,
    nested(input, "data")?.permission_id,
  )
}

function token(input: Record<string, unknown>) {
  return firstText(
    input.token,
    nested(input, "payload")?.token,
    nested(input, "data")?.token,
  )
}

function actor(input: Record<string, unknown>) {
  const user = nested(input, "user") ?? nested(input, "actor") ?? nested(input, "sender")
  const interactionUser = nested(nested(input, "interaction"), "user")
  return firstText(
    input.actorExternalUserId,
    input.actor_external_user_id,
    input.userId,
    input.user_id,
    user?.id,
    user?.userName,
    user?.username,
    user?.login,
    interactionUser?.id,
    interactionUser?.username,
    nested(input, "payload")?.actorExternalUserId,
    nested(input, "payload")?.userId,
    nested(input, "data")?.actorExternalUserId,
    nested(input, "data")?.userId,
  )
}

export function chatSdkApprovalDecision(
  input: unknown,
  options: { threadKey?: string } = {},
): ApprovalDecision | undefined {
  const row = record(input)
  if (!row) return
  const nextCallId = callId(row)
  const nextToken = token(row)
  const approved = decisionValue(row)
  const actorExternalUserId = actor(row)
  if ((!nextCallId && !nextToken) || approved === undefined || !actorExternalUserId) return
  return {
    ...(nextCallId ? { callId: nextCallId } : {}),
    ...(nextToken ? { token: nextToken } : {}),
    approved,
    actorExternalUserId,
    ...(options.threadKey ? { threadKey: options.threadKey } : {}),
  }
}
