import type { SessionStatus } from "@opencode-ai/sdk/v2"

export function timelineWorking(input: {
  pending: boolean
  blocked: boolean
  status: SessionStatus | undefined
}) {
  const active = input.status?.type === "busy" || input.status?.type === "retry"
  if (input.pending) return active
  if (input.blocked) return false
  return active
}
