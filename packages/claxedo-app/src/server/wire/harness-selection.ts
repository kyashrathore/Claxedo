import { AGENT_HARNESS_IDS, type SessionHarness } from "@claxedo/agent-runtime-contract"
import { harnessSelectionOf, type HarnessSelection } from "../../lib/harness-selection"

const isNativeHarness = (harness: string) => AGENT_HARNESS_IDS.some((id) => id === harness)

export function harnessSelectionQuery(harness: string) {
  return isNativeHarness(harness) ? { nativeHarness: harness } : { connectionId: harness }
}

export function harnessIdentityOf(input: HarnessSelection): SessionHarness {
  return input.kind === "native" ? { id: input.harnessId, access: "native" } : { id: input.connectionId, access: "connection" }
}

export function harnessIdentity(harness: string) {
  return harnessIdentityOf(harnessSelectionOf(harness))
}
