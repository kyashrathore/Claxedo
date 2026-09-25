import { AGENT_HARNESS_IDS } from "@claxedo/agent-runtime-contract"

const isNativeHarness = (harness: string) => AGENT_HARNESS_IDS.some((id) => id === harness)

export function harnessSelectionQuery(harness: string) {
  return isNativeHarness(harness) ? { nativeHarness: harness } : { connectionId: harness }
}

export function harnessIdentity(harness: string) {
  return { id: harness, access: isNativeHarness(harness) ? "native" : "connection" }
}
