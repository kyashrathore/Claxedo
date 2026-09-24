import { AGENT_HARNESS_IDS } from "@claxedo/agent-runtime-contract"

const NATIVE_HARNESSES: ReadonlySet<string> = new Set(AGENT_HARNESS_IDS)

export function harnessSelectionQuery(harness: string) {
  return NATIVE_HARNESSES.has(harness) ? { nativeHarness: harness } : { connectionId: harness }
}

export function harnessIdentity(harness: string) {
  return { id: harness, access: NATIVE_HARNESSES.has(harness) ? "native" : "connection" }
}
