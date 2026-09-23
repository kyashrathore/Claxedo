import { describe, expect, test } from "vitest"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { localHistoryClassifier, type LocalTurnSpan } from "@claxedo/server-core/usage/local-history-classifier"

function turn(input: Partial<TurnUsageRevision> & { messageId: string }, startedAt: number): LocalTurnSpan {
  return {
    startedAt,
    fact: {
      hostId: "host-1",
      sessionRef: "local:/work:session:s-1",
      sessionId: "s-1",
      revision: 3,
      observedAt: startedAt + 50,
      completedAt: startedAt + 100,
      settlement: "final",
      status: "completed",
      location: "local",
      harness: "codex-app-server",
      providerId: "openai",
      modelId: "gpt-5.4",
      nativeSessionId: "thread-1",
      workspaceId: "ws-1",
      tokens: { input: 1, output: 1, reasoning: null, cache: { read: null, write: null } },
      quality: { source: "provider", knownCategories: ["input", "output"] },
      ...input,
    },
  }
}

describe("local history classifier", () => {
  test("claims a native session's rows only inside each metered turn, from its start to its end", () => {
    const classify = localHistoryClassifier(
      [turn({ messageId: "m1" }, 1_000), turn({ messageId: "m2" }, 5_000)],
      { codex: 0 },
    )
    const at = (observedAt: number) => classify({ source: "codex", nativeSessionId: "thread-1", observedAt })

    // The first request of a turn lands before the turn's latest observation.
    expect(at(1_010)).toBe("claxedo")
    expect(at(1_100)).toBe("claxedo")
    expect(at(3_000)).toBe("external")
    expect(at(5_020)).toBe("claxedo")
    expect(at(5_101)).toBe("external")
  })

  test("a running turn claims its native session from its start onwards", () => {
    const running = turn({ messageId: "m1", settlement: "provisional", status: "running" }, 1_000)
    delete running.fact.completedAt
    const classify = localHistoryClassifier([running], { codex: 0 })

    expect(classify({ source: "codex", nativeSessionId: "thread-1", observedAt: 999 })).toBe("external")
    expect(classify({ source: "codex", nativeSessionId: "thread-1", observedAt: 90_000 })).toBe("claxedo")
  })

  test("a cloud workspace's turn never claims this machine's history", () => {
    const classify = localHistoryClassifier(
      [turn({ messageId: "m1", location: "cloud-workspace", hostId: "workspace:ws-1" }, 1_000)],
      { codex: 0 },
    )

    expect(classify({ source: "codex", nativeSessionId: "thread-1", observedAt: 1_050 })).toBe("external")
  })

  test("a row no turn claims is another tool's only once its source is fully metered", () => {
    const classify = localHistoryClassifier([], { codex: 2_000 })

    expect(classify({ source: "codex", nativeSessionId: "direct", observedAt: 1_999 })).toBe("unclassified")
    expect(classify({ source: "codex", nativeSessionId: "direct", observedAt: 2_000 })).toBe("external")
    expect(classify({ source: "claude", nativeSessionId: "direct", observedAt: 9_000 })).toBe("unclassified")
  })

  test("a source with a metered turn that names no native session proves nothing external", () => {
    const anonymous = turn({ messageId: "m1" }, 1_000)
    delete anonymous.fact.nativeSessionId
    const classify = localHistoryClassifier([anonymous], { codex: 0 })

    expect(classify({ source: "codex", nativeSessionId: "direct", observedAt: 9_000 })).toBe("unclassified")
  })
})
