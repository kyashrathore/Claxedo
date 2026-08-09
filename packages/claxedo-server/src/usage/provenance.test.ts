import { describe, expect, test } from "vitest"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness } from "@claxedo/server-core/usage/provenance"

describe("usage provenance", () => {
  const classify = createUsageProvenanceClassifier([{
    source: "codex",
    nativeSessionId: "native-1",
    sessionRef: "workspace:ws-1:session:s-1",
    harness: "codex-app-server",
    workspaceId: "ws-1",
    startedAt: 100,
    endedAt: 200,
  }], { completeSources: ["codex"] })

  test("matches a registered upstream session before aggregation", () => {
    expect(classify({ source: "codex", nativeSessionId: "native-1", observedAt: 150 })).toBe("claxedo")
    expect(classify({ source: "codex", nativeSessionId: "direct", observedAt: 150 })).toBe("external")
  })

  test("quarantines insufficient identity and respects manifest bounds", () => {
    expect(classify({ source: "codex", observedAt: 150 })).toBe("unclassified")
    expect(classify({ source: "codex", nativeSessionId: "native-1", observedAt: 99 })).toBe("external")
    expect(classify({ source: "codex", nativeSessionId: "native-1", observedAt: 201 })).toBe("external")
  })

  test("fails closed while a source manifest is incomplete", () => {
    const incomplete = createUsageProvenanceClassifier([])
    expect(incomplete({ source: "codex", nativeSessionId: "direct", observedAt: 150 })).toBe("unclassified")
  })

  test("uses a persisted per-source boundary without guessing about older history", () => {
    const bounded = createUsageProvenanceClassifier([], { completeAfter: { codex: 100 } })
    expect(bounded({ source: "codex", nativeSessionId: "old-direct", observedAt: 99 })).toBe("unclassified")
    expect(bounded({ source: "codex", nativeSessionId: "new-direct", observedAt: 100 })).toBe("external")
    expect(bounded({ source: "claude", nativeSessionId: "direct", observedAt: 200 })).toBe("unclassified")
  })

  test("maps every TokenTracker-backed Claxedo harness family to its native source", () => {
    expect(["claude-sdk", "codex-app-server", "cursor-sdk", "opencode", "pi"].map(tokenTrackerSourceForHarness))
      .toEqual(["claude", "codex", "cursor", "opencode", "pi"])
  })
})
