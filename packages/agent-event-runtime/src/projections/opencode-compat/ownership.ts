export type OpencodeCompatProjectionOwner = "runtime" | "opencode-legacy"

export type OpencodeCompatibilityException = {
  owner: string
  reason: string
  module: string
  symbol: string
  canonicalReplacement: string
  removalCondition: string
  tests: readonly string[]
  productionUseAllowlist: readonly string[]
}

export const OPENCODE_COMPATIBILITY_EXCEPTIONS = [
  {
    owner: "OpenCode legacy adapter runtime publisher",
    reason: "Legacy OpenCode sessions receive OpenCode-compatible SSE frames from the upstream OpenCode server and need a fenced bridge into runtime-native live subscribers until those sessions are replaced by runtime-native journal records.",
    module: "packages/agent-event-runtime/src/projections/opencode-compat/runtime-event.ts",
    symbol: "legacyRuntimeEventFromOpencodeCompat",
    canonicalReplacement: "Runtime-native sessions append AgentRuntimeEvent records to RuntimeStore and project OpenCode-compatible output from committed runtime journal records.",
    removalCondition: "OpenCode legacy sessions are no longer a production session family, or the OpenCode adapter appends runtime-native journal records before publishing live output.",
    tests: [
      "packages/agent-event-runtime/src/projections/opencode-compat/runtime-event.test.ts",
      "packages/agent-sdk-runtime/src/harnesses/opencode/index.test.ts",
    ],
    productionUseAllowlist: [
      "packages/agent-event-runtime/src/projections/opencode-compat/ownership.ts",
      "packages/agent-event-runtime/src/projections/opencode-compat/runtime-event.ts",
      "packages/agent-sdk-runtime/src/harnesses/opencode/events.ts",
    ],
  },
] as const satisfies readonly OpencodeCompatibilityException[]

export function opencodeCompatProjectionOwner(input: { sessionId: string }): OpencodeCompatProjectionOwner {
  return input.sessionId.startsWith("ses_") ? "opencode-legacy" : "runtime"
}

export function runtimeOwnsOpencodeCompatProjection(input: { sessionId: string }) {
  return opencodeCompatProjectionOwner(input) === "runtime"
}

export function opencodeLegacyOwnsCompatProjection(input: { sessionId: string }) {
  return opencodeCompatProjectionOwner(input) === "opencode-legacy"
}
