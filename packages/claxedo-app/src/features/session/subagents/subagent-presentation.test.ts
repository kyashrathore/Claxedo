import { describe, expect, test } from "bun:test"
import { createSubagentRegistry } from "./subagent-registry"
import { hydrateSubagentRows, presentSubagents, subagentStatusLabel } from "./subagent-presentation"

describe("subagent presentation", () => {
  test("hydrates explicit tool edges and never derives identity from display copy", () => {
    const registry = createSubagentRegistry()
    hydrateSubagentRows(registry, "parent", [{
      subagentKey: "host-key",
      revision: 4,
      status: "running",
      description: "Inspect the flaky suite",
      childSessionId: "child",
      transcript: { kind: "live", ref: "opaque" },
      toolCallEdges: [{ toolCallId: "tool-1", role: "spawn", revision: 1 }],
    }])

    expect(presentSubagents(registry, "parent", "tool-1")).toEqual([{
      parentSessionId: "parent",
      subagentKey: "host-key",
      toolCallRole: "spawn",
      status: "running",
      label: "Subagent",
      agentLabel: "Subagent",
      description: "Inspect the flaky suite",
      childSessionId: "child",
      transcriptKind: "live",
      resolution: "ready",
      ambient: false,
    }])
    expect(presentSubagents(registry, "parent", "Inspect the flaky suite")).toEqual([])
  })

  test("covers every status and unknown fallback with deterministic copy", () => {
    expect([
      "pending",
      "running",
      "paused",
      "interrupted",
      "completed",
      "failed",
      "killed",
      "unknown",
    ].map((status) => subagentStatusLabel(status as Parameters<typeof subagentStatusLabel>[0]))).toEqual([
      "Pending",
      "Working",
      "Paused",
      "Interrupted",
      "Completed",
      "Failed",
      "Killed",
      "Status unavailable",
    ])
  })

  test("keeps transcript-none and unbound transcripts honest", () => {
    const registry = createSubagentRegistry()
    hydrateSubagentRows(registry, "parent", [
      { subagentKey: "none", revision: 1, transcript: { kind: "none" } },
      { subagentKey: "later", revision: 1, transcript: { kind: "messages", ref: "opaque" } },
    ])

    expect(presentSubagents(registry, "parent").map((item) => [item.subagentKey, item.resolution])).toEqual([
      ["later", "not-yet-bound"],
      ["none", "unavailable"],
    ])
  })

  test("an edge that names no rendered spawn part leaves the row ambient", () => {
    const registry = createSubagentRegistry()
    hydrateSubagentRows(registry, "parent", [
      // A lane spawned inside a skill's forked execution: its edge names a call
      // the parent transcript never carries as a part.
      { subagentKey: "fork-lane", revision: 1, status: "running", childSessionId: "child-a",
        toolCallEdges: [{ toolCallId: "call-in-fork", role: "spawn", revision: 1 }] },
      // A lane whose spawn row exists in the transcript keeps its inline home.
      { subagentKey: "task-lane", revision: 1, status: "running", childSessionId: "child-b",
        toolCallEdges: [{ toolCallId: "call-on-parent", role: "spawn", revision: 1 }] },
      { subagentKey: "edgeless", revision: 1, status: "running", childSessionId: "child-c" },
    ])
    const hostable = new Set(["call-on-parent"])

    expect(
      presentSubagents(registry, "parent", undefined, hostable).map((item) => [item.subagentKey, item.ambient]),
    ).toEqual([
      ["edgeless", true],
      ["fork-lane", true],
      ["task-lane", false],
    ])
    // Without the host set the legacy rule stands — edges alone suppress ambient.
    expect(presentSubagents(registry, "parent").map((item) => [item.subagentKey, item.ambient])).toEqual([
      ["edgeless", true],
      ["fork-lane", false],
      ["task-lane", false],
    ])
    // Per-call resolution is unaffected: an edge still answers its own lookup.
    expect(presentSubagents(registry, "parent", "call-in-fork", hostable).map((item) => item.subagentKey)).toEqual(["fork-lane"])
  })
})
