import { harnessKey, type SessionHarness } from "@claxedo/agent-runtime-contract"

/** The harness id a usage fact is filed under: the session's committed harness key. */
export function meteringHarnessId(harness: SessionHarness) {
  const key = harnessKey(harness)
  if (!key) throw new Error(`Unsupported harness identity: ${harness.access}:${harness.id}`)
  return key
}
