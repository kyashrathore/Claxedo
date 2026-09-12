export type PromptAdmission = "admit" | "steer" | "abort-active" | "ignore"

/**
 * What the composer's primary control does with a submission.
 *
 * A draft submitted while a turn runs is sent to that turn — Send means send,
 * whatever the session is doing. The control only stops the turn when there is
 * nothing to send, which is the state it renders as Stop.
 */
export function admitPromptSubmission(input: {
  readonly bodyMd: string
  readonly imageCount?: number
  readonly commentCount?: number
  readonly working?: boolean
}): PromptAdmission {
  const hasContent = input.bodyMd.trim().length > 0 || !!input.imageCount || !!input.commentCount
  if (input.working) return hasContent ? "steer" : "abort-active"
  return hasContent ? "admit" : "ignore"
}
