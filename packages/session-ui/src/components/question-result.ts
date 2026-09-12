import { asRecord } from "@claxedo/helpers/guards"

/**
 * Whether a `question` tool's error is the user declining rather than a failure. The
 * harness that produced the error says so on the part's metadata; the error text is
 * free prose the CLI is entitled to reword.
 */
export function isQuestionDeclined(metadata: Record<string, unknown>): boolean {
  return asRecord(metadata.question)?.declined === true
}
