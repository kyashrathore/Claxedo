import { asRecord } from "@claxedo/helpers/guards"

export function isQuestionDeclined(metadata: Record<string, unknown>): boolean {
  return asRecord(metadata.question)?.declined === true
}
