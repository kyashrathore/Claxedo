export function transcriptText(messages: unknown[]) {
  return messages.flatMap((message) => readableTranscriptText(message)).filter(Boolean).join("\n\n")
}

function readableTranscriptText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap(readableTranscriptText)
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return readableTranscriptText(record.text)
  if (typeof record.content === "string" || Array.isArray(record.content)) return readableTranscriptText(record.content)
  if (record.message) return readableTranscriptText(record.message)
  return []
}

export function scopedSubagentKey(parentSessionId: string, key: string) {
  return `${parentSessionId}\0${key}`
}

export async function openSubagentTranscript(
  registrar: SdkRuntimeTranscriptRegistrar | undefined,
  parentSessionId: string,
  observation: SubagentObservation,
): Promise<OpenedSubagentTranscript | undefined> {
  const transcript = observation.transcript
  if (transcript?.kind !== "file" || !transcript.ref) return
  return await registrar?.open?.({ parentSessionId, handle: transcript.ref })
}

export function admissibleSubagentObservation(
  observation: SubagentObservation,
  transcript: OpenedSubagentTranscript | undefined,
): SubagentObservation {
  if (observation.transcript?.kind !== "file") return observation
  if (transcript && transcript.state !== "unavailable") return observation
  return { ...observation, transcript: { kind: "none" } }
}

export function subagentCorrelationKeys(configured: string[] | undefined, observation: SubagentObservation) {
  return [...new Set([
    ...(configured ?? []),
    observation.stableCorrelationId,
    observation.providerId,
  ].filter((key): key is string => !!key))]
}

// Child-session identity is resolved by the subagent admission store
// (`subagent-admission.ts`): it reuses the resolved row's bound child, honors
// a harness-named child, or allocates one via `allocateChildSessionId`.
// Deliberately no helper here derives a child id from adapter-side state — a
// second resolver can disagree with admission's row resolution and hand one
// row's child to another, which the durable store's unique child index
// rejects mid-turn.

export function subagentOutcome(observation: SubagentObservation) {
  const completedAt = Date.now()
  if (observation.status === "failed") {
    return { status: "failed" as const, completedAt, error: observation.label ?? "Subagent failed" }
  }
  if (observation.status === "completed") return { status: "completed" as const, completedAt }
  if (observation.status === "killed" || observation.status === "interrupted") {
    return { status: "cancelled" as const, completedAt, reason: observation.status }
  }
}
import type { SubagentObservation } from "../../subagent-admission"
import type { SdkRuntimeTranscriptRegistrar } from "./sdk-runtime-driver"

export type OpenedSubagentTranscript =
  | { state: "ready"; messages: unknown[] }
  | { state: "empty"; messages: [] }
  | { state: "unavailable"; reason: string }
