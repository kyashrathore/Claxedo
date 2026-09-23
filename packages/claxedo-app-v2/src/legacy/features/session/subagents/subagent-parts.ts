import { isSubagentHostPart } from "@/ui/session-kit"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"

/**
 * The call ids a subagent edge can hang a chip on — spawn parts the transcript
 * actually renders, including an interrupted wrapper with an admitted child.
 * Lanes spawned inside a skill's forked execution edge to calls that never land as parts at all; edges
 * that miss this set leave the row homeless, so the ambient row is its only
 * surface.
 */
export function subagentHostCallIds(partsByMessage: Readonly<Record<string, readonly AgentContentPart[] | undefined>>): Set<string> {
  const ids = new Set<string>()
  for (const parts of Object.values(partsByMessage)) {
    for (const part of parts ?? []) {
      if (part.type === "tool" && part.callID && isSubagentHostPart(part)) ids.add(part.callID)
    }
  }
  return ids
}
