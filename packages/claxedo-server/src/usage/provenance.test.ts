import { describe, expect, test } from "vitest"
import { createUsageProvenanceClassifier } from "./provenance"

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
})
