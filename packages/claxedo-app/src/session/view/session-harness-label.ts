import { harnessProductLabel } from "@claxedo/agent-runtime-contract"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import type { HarnessSelection } from "@/lib/harness-selection"

export function sessionHarnessLabel(harness: HarnessSelection | string | undefined): string | undefined {
  if (!harness) return undefined
  const id = typeof harness === "string" ? harness : harness.kind === "native" ? harness.harnessId : harness.connectionId
  return harnessProductLabel(id) ?? harnessDisplayLabel(id)
}
