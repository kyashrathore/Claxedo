import { isSubagentHostPart } from "@/transcript"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"

export function subagentHostCallIds(partsByMessage: Readonly<Record<string, readonly AgentContentPart[] | undefined>>): Set<string> {
  const ids = new Set<string>()
  for (const parts of Object.values(partsByMessage)) {
    for (const part of parts ?? []) {
      if (part.type === "tool" && part.callID && isSubagentHostPart(part)) ids.add(part.callID)
    }
  }
  return ids
}
