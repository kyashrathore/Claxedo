import { HARNESS_TABLE, isHarnessId } from "@claxedo/agent-runtime-contract"
import type { ProviderTurnInput } from "@claxedo/harness/contract"

export type ProviderTurnAuthor = { id: string; name: string; kind: "agent" }

export function providerTurnNotice(input: ProviderTurnInput): string {
  if (input.reason === "goal") return input.detail ? `Goal: ${input.detail}` : "Goal"
  return input.detail ?? "Continued on its own"
}

export function harnessAuthor(harnessId: string): ProviderTurnAuthor {
  return { id: `harness:${harnessId}`, name: isHarnessId(harnessId) ? HARNESS_TABLE[harnessId].label : harnessId, kind: "agent" }
}
