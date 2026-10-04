import { trimToUndefined } from "@claxedo/helpers/string"
import type { ApprovalDecision, ChannelChatType, ChannelId } from "../envelope"
import { asRecord } from "@claxedo/helpers/guards"

/**
 * The exact action ids the approval card's buttons are rendered with
 * (`chat-sdk-render.ts`). A press is an approval ONLY when `actionId` is one
 * of these verbatim — never a substring ("approve_permission"), a near-miss
 * ("claxedo_approve_v2"), or a word a human typed ("yesterday" contains "yes").
 * Anything else the platform delivers is not ours to interpret.
 */
export const APPROVAL_ACTION_ID = {
  approve: "claxedo_approve",
  deny: "claxedo_deny",
} as const

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
  return trimToUndefined(asRecord(input.user)?.userId)
}

/**
 * Normalize an `ActionEvent` into an approval decision.
 *
 * The wire contract is exactly three fields: `actionId` says which button was
 * pressed (approve vs deny), `value` carries the prompt token verbatim, and
 * `messageId` names the card message the press landed on — the identity a
 * redelivered press dedups under. No other field on the event (`data`,
 * `payload`, an `approved` flag, a decision string) is consulted: the SDK does
 * not send them for card presses, so anything found there is attacker-controlled
 * or unrelated shape, not a decision.
 */
export function chatSdkApprovalPress(
  input: unknown,
  options: {
    channel?: ChannelId
    chatType?: ChannelChatType
    threadKey?: string
  } = {},
): ApprovalDecision | undefined {
  const row = asRecord(input)
  if (!row) return undefined
  const actionId = trimToUndefined(row.actionId)
  const approved = actionId === APPROVAL_ACTION_ID.approve ? true
    : actionId === APPROVAL_ACTION_ID.deny ? false
    : undefined
  if (approved === undefined) return undefined
  const token = trimToUndefined(row.value)
  const messageId = trimToUndefined(row.messageId)
  const actorExternalUserId = actor(row)
  if (!token || !messageId || !actorExternalUserId) return undefined
  return {
    actionId,
    messageId,
    token,
    approved,
    actorExternalUserId,
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.chatType ? { chatType: options.chatType } : {}),
    ...(options.threadKey ? { threadKey: options.threadKey } : {}),
  }
}
