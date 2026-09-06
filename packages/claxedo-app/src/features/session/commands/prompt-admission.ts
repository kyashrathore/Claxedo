export type PromptAdmission = "admit" | "abort-active" | "ignore"

/** The primary composer control stops an active turn, even with a queued draft. */
export function admitPromptSubmission(input: {
  readonly bodyMd: string
  readonly imageCount?: number
  readonly commentCount?: number
  readonly working?: boolean
}): PromptAdmission {
  if (input.working) return "abort-active"
  if (input.bodyMd.trim().length > 0 || input.imageCount || input.commentCount) return "admit"
  return "ignore"
}
