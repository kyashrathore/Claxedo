import { trimToUndefined } from "@claxedo/helpers/string"
import type { ApprovalDecision } from "../envelope"
import { asRecord } from "@claxedo/helpers/guards"

function bool(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined
}

function firstText(...input: unknown[]): string | undefined {
  for (const item of input) {
    const value = trimToUndefined(item)
    if (value) return value
  }
  return undefined
}

function nested(input: Record<string, unknown> | undefined, key: string) {
  return asRecord(input?.[key])
}

function decisionValue(input: Record<string, unknown>): boolean | undefined {
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
  if (!value) return undefined
  if (/approve|allow|yes|once/.test(value)) return true
  if (/deny|reject|no/.test(value)) return false
  return undefined
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

/**
 * Who pressed the button: `ActionEvent.user.userId`, the stable account id the
 * Chat SDK fills on every platform.
 *
 * This is the one place the presser is named, and it reads one field. The
 * handle beside it (`userName`) is renameable and reassignable, so admitting it
 * as a second source would let a new owner of an old handle answer a prompt
 * addressed to the previous one — the approval bridge compares this value
 * against the requestee recorded when the prompt was posted.
 */
function actor(input: Record<string, unknown>) {
  return trimToUndefined(nested(input, "user")?.userId)
}

export function chatSdkApprovalDecision(
  input: unknown,
  options: { threadKey?: string } = {},
): ApprovalDecision | undefined {
  const row = asRecord(input)
  if (!row) return undefined
  const nextCallId = callId(row)
  const nextToken = token(row)
  const approved = decisionValue(row)
  const actorExternalUserId = actor(row)
  if ((!nextCallId && !nextToken) || approved === undefined || !actorExternalUserId) return undefined
  return {
    ...(nextCallId ? { callId: nextCallId } : {}),
    ...(nextToken ? { token: nextToken } : {}),
    approved,
    actorExternalUserId,
    ...(options.threadKey ? { threadKey: options.threadKey } : {}),
  }
}
