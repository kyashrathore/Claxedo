import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { scanTokenTrackerLocalHistory } from "./token-tracker-local-history"
import { createUsageProvenanceClassifier } from "../provenance"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-history-"))
  roots.push(root)
  const project = path.join(root, ".claude", "projects", "fixture")
  await fs.mkdir(project, { recursive: true })
  const observedAt = Date.UTC(2026, 7, 8, 12)
  const row = (sessionId: string, input: number) => JSON.stringify({
    sessionId,
    timestamp: new Date(observedAt).toISOString(),
    cwd: "/private/secret-project",
    prompt: "must never escape",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: "private response",
      usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 3 },
    },
  })
  await fs.writeFile(path.join(project, "direct.jsonl"), `${row("direct", 10)}\n`)
  await fs.writeFile(path.join(project, "claxedo.jsonl"), `${row("native-claxedo", 30)}\n`)
  return { root, observedAt }
}

describe("TokenTracker embedded local history", () => {
  test("classifies before bucketing, excludes overlap, and emits no content or path", async () => {
    const { root, observedAt } = await fixture()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const stateDir = path.join(root, "claxedo-state")
    const classify = createUsageProvenanceClassifier([{
      source: "claude",
      nativeSessionId: "native-claxedo",
      sessionRef: "workspace:ws-1:session:s-1",
      harness: "claude-sdk",
      startedAt: observedAt - 1,
      endedAt: observedAt + 1,
    }], { completeSources: ["claude"] })
    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir,
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify,
    })
    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "claude",
      nativeSessionId: "direct",
      tokens: expect.objectContaining({ input: 10, output: 20, cacheRead: 3 }),
    })])
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.unclassified).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain("secret-project")
    expect(JSON.stringify(snapshot)).not.toContain("private response")
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(fs.stat(stateDir)).rejects.toThrow()
  })

  test("reports a corrupt source as degraded while unsupported sources stay quarantined", async () => {
    const { root, observedAt } = await fixture()
    await fs.writeFile(path.join(root, ".claude", "projects", "fixture", "broken.jsonl"), "not-json\n")
    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude", "cursor"],
      classify: () => "external",
    })
    expect(snapshot.coverage).toEqual([
      expect.objectContaining({ source: "claude", status: "degraded" }),
      expect.objectContaining({ source: "cursor", status: "unsupported" }),
    ])
  })
})
