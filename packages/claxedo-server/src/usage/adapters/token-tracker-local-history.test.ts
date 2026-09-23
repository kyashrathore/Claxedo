import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import Database from "better-sqlite3"
import { scanTokenTrackerLocalHistory } from "@claxedo/local-server/self-hosted-execution"
import { createUsageProvenanceClassifier } from "@claxedo/server-core/usage/provenance"

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
  const prompt = (sessionId: string) => JSON.stringify({
    type: "user",
    sessionId,
    timestamp: new Date(observedAt - 1).toISOString(),
    message: { role: "user", content: "must never escape" },
  })
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
  await fs.writeFile(path.join(project, "direct.jsonl"), `${prompt("direct")}\n${row("direct", 10)}\n`)
  await fs.writeFile(path.join(project, "claxedo.jsonl"), `${prompt("native-claxedo")}\n${row("native-claxedo", 30)}\n`)
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
      tokens: { input: 10, output: 20, reasoning: null, cacheRead: 3, cacheWrite: null, cacheWrite1h: null },
    })])
    expect(snapshot.totalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeSessionId: "direct" }),
      expect.objectContaining({ nativeSessionId: "native-claxedo" }),
    ]))
    expect(snapshot.totalRows).toHaveLength(2)
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.unclassifiedRequests).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain("secret-project")
    expect(JSON.stringify(snapshot)).not.toContain("private response")
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(fs.stat(stateDir)).resolves.toMatchObject({ mode: expect.any(Number) })
  })

  test("retains pre-coverage rows for Total without calling them external", async () => {
    const { root, observedAt } = await fixture()
    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: () => "unclassified",
    })

    expect(snapshot.rows).toEqual([])
    expect(snapshot.totalRows).toHaveLength(2)
    expect(snapshot.unclassifiedRequests).toBe(2)
  })

  test("counts each unattributed request, not each prompt, so a turn of many requests is not hidden", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-history-"))
    roots.push(root)
    const project = path.join(root, ".claude", "projects", "fixture")
    await fs.mkdir(project, { recursive: true })
    const observedAt = Date.UTC(2026, 7, 8, 12)
    const prompt = JSON.stringify({
      type: "user",
      sessionId: "multi",
      timestamp: new Date(observedAt - 1).toISOString(),
      message: { role: "user", content: "one prompt" },
    })
    const response = (id: string, offset: number) => JSON.stringify({
      type: "assistant",
      sessionId: "multi",
      requestId: `req_${id}`,
      timestamp: new Date(observedAt + offset).toISOString(),
      message: {
        id,
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    await fs.writeFile(
      path.join(project, "multi.jsonl"),
      [prompt, response("msg_1", 0), response("msg_2", 1), response("msg_3", 2)].join("\n") + "\n",
    )
    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: () => "unclassified",
    })

    expect(snapshot.totalRows.reduce((turns, row) => turns + row.turnCount, 0)).toBe(1)
    expect(snapshot.unclassifiedRequests).toBe(3)
  })

  test("serializes identical scans and reuses the Claxedo-owned cache", async () => {
    const { root, observedAt } = await fixture()
    const stateDir = path.join(root, "state")
    const classify = vi.fn(() => "external" as const)
    const input = {
      sourceHome: root,
      stateDir,
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify,
    }
    const [first, concurrent] = await Promise.all([
      scanTokenTrackerLocalHistory(input),
      scanTokenTrackerLocalHistory(input),
    ])
    expect(concurrent).toEqual(first)
    expect(classify).toHaveBeenCalledTimes(2)
    expect(first.scannedAt).toBeGreaterThan(observedAt)

    classify.mockClear()
    await expect(scanTokenTrackerLocalHistory(input)).resolves.toEqual(first)
    expect(classify).not.toHaveBeenCalled()
    const refreshed = await scanTokenTrackerLocalHistory({ ...input, refresh: true })
    expect(refreshed).toEqual({ ...first, scannedAt: refreshed.scannedAt })
    expect(refreshed.scannedAt).toBeGreaterThanOrEqual(first.scannedAt)
    expect(classify).toHaveBeenCalledTimes(2)

    const cursorText = gunzipSync(await fs.readFile(path.join(stateDir, "embedded-history-cursors-v10.json.gz"))).toString("utf8")
    const cursor = JSON.parse(cursorText) as { version: number; files: Record<string, unknown> }
    expect(cursor.version).toBe(10)
    expect(Object.keys(cursor.files)).toHaveLength(2)
    expect(Object.keys(cursor.files).every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true)
    expect(cursorText).not.toContain(root)
    expect(cursorText).not.toContain("secret-project")
    expect(cursorText).not.toContain("private response")
  })

  test("a read never walks transcripts on its own: age, new facts and new files all wait for a refresh", async () => {
    const { root, observedAt } = await fixture()
    const stateDir = path.join(root, "state")
    const input = {
      sourceHome: root,
      stateDir,
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: vi.fn(() => "external" as const),
    }
    const first = await scanTokenTrackerLocalHistory(input)
    const cursors = path.join(stateDir, "embedded-history-cursors-v10.json.gz")
    const cursorsBefore = await fs.stat(cursors)

    // A transcript that grows, a fact set that changes what "Claxedo" means,
    // and a snapshot far older than any refresh interval: the previous policy
    // rescanned every transcript on this machine for each of these.
    const direct = path.join(root, ".claude", "projects", "fixture", "direct.jsonl")
    await fs.appendFile(direct, `${JSON.stringify({
      sessionId: "direct",
      timestamp: new Date(observedAt).toISOString(),
      message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 7, output_tokens: 1 } },
    })}\n`)
    const reclassify = vi.fn(() => "claxedo" as const)
    vi.useFakeTimers({ now: observedAt + 365 * 86_400_000, toFake: ["Date"] })
    try {
      const read = await scanTokenTrackerLocalHistory({ ...input, classify: reclassify })
      expect(read).toEqual(first)
      expect(reclassify).not.toHaveBeenCalled()
      expect((await fs.stat(cursors)).mtimeMs).toBe(cursorsBefore.mtimeMs)

      const narrower = await scanTokenTrackerLocalHistory({ ...input, since: observedAt - 500, until: observedAt + 500, classify: reclassify })
      expect(narrower).toEqual(first)
      expect(reclassify).not.toHaveBeenCalled()

      const refreshed = await scanTokenTrackerLocalHistory({ ...input, refresh: true })
      expect(refreshed.rows.find((row) => row.nativeSessionId === "direct")?.tokens).toMatchObject({ input: 17, output: 21 })
      expect(refreshed.scannedAt).toBe(observedAt + 365 * 86_400_000)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a range the stored snapshot does not cover is the one read that scans", async () => {
    const { root, observedAt } = await fixture()
    const stateDir = path.join(root, "state")
    const classify = vi.fn(() => "external" as const)
    const input = { sourceHome: root, stateDir, since: observedAt - 1_000, until: observedAt + 1_000, sources: ["claude"], classify }
    await scanTokenTrackerLocalHistory(input)
    classify.mockClear()

    const wider = await scanTokenTrackerLocalHistory({ ...input, until: observedAt + 2_000 })
    expect(classify).toHaveBeenCalled()
    classify.mockClear()

    // The wider walk now covers the original range too, so it is served, and
    // the file holds exactly one snapshot: the widest walk, not the latest read.
    await expect(scanTokenTrackerLocalHistory(input)).resolves.toEqual(wider)
    expect(classify).not.toHaveBeenCalled()
    const stored = JSON.parse(await fs.readFile(path.join(stateDir, "local-history-v12.json"), "utf8")) as { since: number; until: number }
    expect(stored).toMatchObject({ since: observedAt - 1_000, until: observedAt + 2_000 })
  })

  test("refreshes a changed file while reusing unchanged file cursors within a numeric warm budget", async () => {
    const { root, observedAt } = await fixture()
    const stateDir = path.join(root, "state")
    const input = {
      sourceHome: root,
      stateDir,
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: () => "external" as const,
    }
    await scanTokenTrackerLocalHistory(input)
    const direct = path.join(root, ".claude", "projects", "fixture", "direct.jsonl")
    await fs.appendFile(direct, `${JSON.stringify({
      sessionId: "direct",
      timestamp: new Date(observedAt).toISOString(),
      message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 7, output_tokens: 1 } },
    })}\n`)

    const startedAt = performance.now()
    const refreshed = await scanTokenTrackerLocalHistory({ ...input, refresh: true })
    const elapsedMs = performance.now() - startedAt
    expect(refreshed.rows.find((row) => row.nativeSessionId === "direct")?.tokens).toMatchObject({ input: 17, output: 21 })
    expect(elapsedMs).toBeLessThan(1_000)
  })

  test("reports mixed valid and corrupt JSONL as degraded", async () => {
    const { root, observedAt } = await fixture()
    await fs.appendFile(path.join(root, ".claude", "projects", "fixture", "direct.jsonl"), "not-json\n")
    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: () => "external",
    })
    expect(snapshot.rows).toHaveLength(2)
    expect(snapshot.coverage).toEqual([expect.objectContaining({ source: "claude", status: "degraded" })])
  })

  test("uses Codex last-token deltas, drops duplicate emissions, and keeps reasoning disjoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-codex-history-"))
    roots.push(root)
    const sessions = path.join(root, ".codex", "sessions", "2026", "08", "08")
    await fs.mkdir(sessions, { recursive: true })
    const observedAt = Date.UTC(2026, 7, 8, 12)
    const usage = (timestamp: number, last: Record<string, number>, total: Record<string, number>) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
    })
    const first = {
      input_tokens: 100, cached_input_tokens: 60, output_tokens: 20,
      reasoning_output_tokens: 6, total_tokens: 120,
    }
    const second = {
      input_tokens: 50, cached_input_tokens: 20, output_tokens: 10,
      reasoning_output_tokens: 2, total_tokens: 60,
    }
    await fs.writeFile(path.join(sessions, "rollout.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-direct", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      usage(observedAt, first, first),
      JSON.stringify({
        timestamp: new Date(observedAt).toISOString(),
        type: "event_msg",
        payload: { type: "compat", msg: { type: "token_count", info: { last_token_usage: { ...first, cached_input_tokens: 9_999_999 } } } },
      }),
      usage(observedAt + 1, first, first),
      usage(observedAt + 2, second, {
        input_tokens: 150, cached_input_tokens: 80, output_tokens: 30,
        reasoning_output_tokens: 8, total_tokens: 180,
      }),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1,
      until: observedAt + 10,
      sources: ["codex"],
      classify: () => "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "codex",
      provider: "openai",
      nativeSessionId: "codex-direct",
      model: "gpt-5.6-sol",
      tokens: { input: 70, output: 22, reasoning: 8, cacheRead: 80, cacheWrite: 0, cacheWrite1h: null },
    })])
    const totals = snapshot.rows[0].tokens
    expect((totals.input ?? 0) + (totals.output ?? 0) + (totals.reasoning ?? 0) + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0)).toBe(180)
  })

  test.each([
    { label: "forked_from_id", forkMarker: { forked_from_id: "codex-parent" } },
    {
      label: "subagent thread_spawn",
      forkMarker: { source: { subagent: { thread_spawn: { parent_thread_id: "codex-parent" } } } },
    },
  ])("counts copied parent history only once for a Codex $label rollout", async ({ forkMarker }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-codex-fork-history-"))
    roots.push(root)
    const sessions = path.join(root, ".codex", "sessions", "2026", "08", "08")
    await fs.mkdir(sessions, { recursive: true })
    const forkedAt = Date.UTC(2026, 7, 8, 12)
    const usage = (timestamp: number, input: number, cached: number, output: number) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
        },
      },
    })
    const completed = (timestamp: number) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "done" },
    })
    const context = (timestamp: number) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "turn_context",
      payload: { type: "turn_context", model: "gpt-5.6-sol" },
    })
    const parentMeta = (timestamp: number) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "session_meta",
      payload: { type: "session_meta", id: "codex-parent", model_provider: "openai" },
    })
    await fs.writeFile(path.join(sessions, "parent.jsonl"), [
      parentMeta(forkedAt - 10_000),
      context(forkedAt - 9_000),
      usage(forkedAt - 8_000, 100, 60, 20),
      completed(forkedAt - 7_000),
    ].join("\n"))
    await fs.writeFile(path.join(sessions, "child.jsonl"), [
      JSON.stringify({
        timestamp: new Date(forkedAt).toISOString(),
        type: "session_meta",
        payload: {
          type: "session_meta",
          id: "codex-child",
          ...forkMarker,
          model_provider: "openai",
        },
      }),
      parentMeta(forkedAt),
      context(forkedAt + 1),
      usage(forkedAt + 2, 100, 60, 20),
      completed(forkedAt + 3),
      context(forkedAt + 5_000),
      usage(forkedAt + 6_000, 50, 20, 10),
      completed(forkedAt + 7_000),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: forkedAt - 60_000,
      until: forkedAt + 20_000,
      sources: ["codex"],
      classify: () => "external",
    })

    expect(snapshot.totalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeSessionId: "codex-parent",
        turnCount: 1,
        tokens: { input: 40, output: 20, reasoning: 0, cacheRead: 60, cacheWrite: 0, cacheWrite1h: null },
      }),
      expect.objectContaining({
        nativeSessionId: "codex-child",
        turnCount: 1,
        tokens: { input: 30, output: 10, reasoning: 0, cacheRead: 20, cacheWrite: 0, cacheWrite1h: null },
      }),
    ]))
    expect(snapshot.totalRows).toHaveLength(2)
  })

  test("counts a completed Codex turn once however many token snapshots it emits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-codex-identical-turns-"))
    roots.push(root)
    const sessions = path.join(root, ".codex", "sessions", "2026", "08", "08")
    await fs.mkdir(sessions, { recursive: true })
    const observedAt = Date.UTC(2026, 7, 8, 12, 29, 59)
    const delta = {
      input_tokens: 100, cached_input_tokens: 60, output_tokens: 20,
      reasoning_output_tokens: 6, total_tokens: 120,
    }
    const row = (timestamp: number, total: Record<string, number>) => JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: delta, total_token_usage: total } },
    })
    await fs.writeFile(path.join(sessions, "rollout.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-identical", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      row(observedAt, delta),
      row(observedAt + 1, {
        input_tokens: 200, cached_input_tokens: 120, output_tokens: 40,
        reasoning_output_tokens: 12, total_tokens: 240,
      }),
      JSON.stringify({
        timestamp: new Date(observedAt + 1_200).toISOString(),
        type: "event_msg",
        payload: { type: "agent_message", message: "checking" },
      }),
      JSON.stringify({
        timestamp: new Date(observedAt + 1_500).toISOString(),
        type: "event_msg",
        payload: { type: "agent_message", message: "done" },
      }),
      JSON.stringify({
        timestamp: new Date(observedAt + 2_000).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" },
      }),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 3_000,
      sources: ["codex"],
      classify: () => "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      nativeSessionId: "codex-identical",
      turnCount: 1,
      tokens: { input: 80, output: 28, reasoning: 12, cacheRead: 120, cacheWrite: 0, cacheWrite1h: null },
    })])
  })

  test("counts aborted Codex turns, which write no task_complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-codex-aborted-"))
    roots.push(root)
    const sessions = path.join(root, ".codex", "sessions", "2026", "09", "20")
    await fs.mkdir(sessions, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 20, 8, 0, 0)
    const at = (offset: number) => new Date(observedAt + offset).toISOString()
    const usage = (input: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 })
    await fs.writeFile(path.join(sessions, "rollout.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-aborted", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
      JSON.stringify({ timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ timestamp: at(1_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(10), total_token_usage: usage(10) } } }),
      JSON.stringify({ timestamp: at(2_000), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }),
      JSON.stringify({ timestamp: at(3_000), type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
      JSON.stringify({ timestamp: at(4_000), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(20), total_token_usage: usage(30) } } }),
      JSON.stringify({ timestamp: at(5_000), type: "event_msg", payload: { type: "task_complete", turn_id: "t2" } }),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 60_000,
      sources: ["codex"],
      classify: () => "external",
    })

    expect(snapshot.rows.reduce((sum, row) => sum + row.turnCount, 0)).toBe(2)
    expect(snapshot.rows.reduce((sum, row) => sum + (row.tokens.input ?? 0), 0)).toBe(30)
  })

  test("meters each Codex response record once, including the one a compaction left without a token snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-codex-records-"))
    roots.push(root)
    const sessions = path.join(root, ".codex", "sessions", "2026", "09", "20")
    await fs.mkdir(sessions, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 20, 8, 0, 0)
    const at = (offset: number) => new Date(observedAt + offset).toISOString()
    const usage = (input: number, cached: number, output: number, reasoning: number) => ({
      input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
    })
    const record = (offset: number, responseId: string, value: ReturnType<typeof usage>, threadId = "codex-records") => JSON.stringify({
      timestamp: at(offset),
      type: "token_usage_record",
      payload: { thread_id: threadId, session_id: threadId, turn_id: "turn-1", response_id: responseId, usage: value },
    })
    const tokenCount = (offset: number, last: ReturnType<typeof usage>, total: ReturnType<typeof usage>) => JSON.stringify({
      timestamp: at(offset),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
    })
    const first = usage(1_000, 600, 50, 10)
    const beforeCompaction = usage(2_000, 1_500, 80, 20)
    await fs.writeFile(path.join(sessions, "rollout.jsonl"), [
      JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "codex-records", model_provider: "openai" } }),
      JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-6-astra" } }),
      JSON.stringify({ timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      record(1_000, "resp_1", first),
      tokenCount(1_100, first, first),
      record(2_000, "resp_2", beforeCompaction),
      JSON.stringify({ timestamp: at(3_000), type: "compacted", payload: { message: "", replacement_history: [] } }),
      record(3_100, "resp_1", first),
      record(3_200, "resp_parent", usage(9_000, 0, 900, 0), "codex-parent"),
      JSON.stringify({ timestamp: at(4_000), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
      tokenCount(86_400_000, beforeCompaction, usage(3_000, 2_100, 130, 30)),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 2 * 86_400_000,
      sources: ["codex"],
      classify: () => "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      nativeSessionId: "codex-records",
      model: "gpt-6-astra",
      bucketStart: observedAt,
      turnCount: 1,
      tokens: { input: 900, output: 100, reasoning: 30, cacheRead: 2_100, cacheWrite: 0, cacheWrite1h: null },
    })])
  })

  test("counts one OpenCode turn per user message however many steps answer it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-turns-"))
    roots.push(root)
    const dataDir = path.join(root, ".local", "share", "opencode")
    await fs.mkdir(dataDir, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 20, 9, 0, 0)
    const db = new Database(path.join(dataDir, "opencode.db"))
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    const step = (id: string, parentID: string, offset: number) => insert.run(id, "ses_1", observedAt + offset, observedAt + offset + 500, JSON.stringify({
      role: "assistant",
      parentID,
      providerID: "opencode",
      modelID: "union-alpha",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
      time: { created: observedAt + offset, completed: observedAt + offset + 500 },
    }))
    insert.run("msg_u1", "ses_1", observedAt - 1_000, observedAt - 1_000, JSON.stringify({ role: "user" }))
    step("msg_a1", "msg_u1", 0)
    step("msg_a2", "msg_u1", 1_000)
    step("msg_a3", "msg_u1", 2_000)
    insert.run("msg_u2", "ses_1", observedAt + 9_000, observedAt + 9_000, JSON.stringify({ role: "user" }))
    step("msg_a4", "msg_u2", 10_000)
    db.close()

    const scan = async (since: number) => {
      const snapshot = await scanTokenTrackerLocalHistory({
        sourceHome: root,
        stateDir: path.join(root, `state-${since}`),
        since,
        until: observedAt + 60_000,
        sources: ["opencode"],
        classify: () => "external",
      })
      return {
        turns: snapshot.rows.reduce((sum, row) => sum + row.turnCount, 0),
        input: snapshot.rows.reduce((sum, row) => sum + (row.tokens.input ?? 0), 0),
      }
    }
    expect(await scan(observedAt - 60_000)).toEqual({ turns: 2, input: 40 })
    expect(await scan(observedAt + 1_000)).toEqual({ turns: 1, input: 30 })
  })

  test("a new scanner state version removes the files earlier versions wrote", async () => {
    const { root, observedAt } = await fixture()
    const stateDir = path.join(root, "state")
    await fs.mkdir(stateDir, { recursive: true })
    const stale = ["embedded-history-cursors-v8.json.gz", "embedded-history-cursors-v9.json.gz", "local-history-v9.json", "local-history-v10.json", "local-history-v11.json"]
    for (const name of [...stale, "unrelated.json"]) await fs.writeFile(path.join(stateDir, name), "{}")

    await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir,
      since: observedAt - 1_000,
      until: observedAt + 1_000,
      sources: ["claude"],
      classify: () => "external",
    })

    expect((await fs.readdir(stateDir)).toSorted()).toEqual([
      "embedded-history-cursors-v10.json.gz",
      "local-history-v12.json",
      "unrelated.json",
    ])
  })

  test("deduplicates copied Claude messages globally across resumed transcripts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-claude-dedupe-"))
    roots.push(root)
    const project = path.join(root, ".claude", "projects", "fixture")
    await fs.mkdir(project, { recursive: true })
    const observedAt = Date.UTC(2026, 7, 8, 12)
    const copied = (sessionId: string, rowId: string) => JSON.stringify({
      id: rowId,
      type: "assistant",
      sessionId,
      requestId: "request-1",
      timestamp: new Date(observedAt).toISOString(),
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 },
      },
    })
    await fs.writeFile(path.join(project, "original.jsonl"), copied("session-1", "row-1"))
    await fs.writeFile(path.join(project, "resumed.jsonl"), copied("session-2", "row-2"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1,
      until: observedAt + 1,
      sources: ["claude"],
      classify: () => "external",
    })

    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]?.provider).toBe("anthropic")
    expect(snapshot.rows[0]?.tokens).toMatchObject({ input: 10, output: 2, cacheRead: 100 })
  })

  test("keeps each Claude response's final output count, not its streaming snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-claude-final-line-"))
    roots.push(root)
    const project = path.join(root, ".claude", "projects", "fixture")
    await fs.mkdir(project, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 22, 22, 44, 18)
    // Claude Code writes one row per content block of a response; only the
    // row that carries stop_reason holds the final output_tokens.
    const block = (offset: number, type: string, output: number, stopReason: string | null) => JSON.stringify({
      type: "assistant",
      sessionId: "session-final",
      requestId: "req_1",
      timestamp: new Date(observedAt + offset).toISOString(),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-fable-5-1",
        stop_reason: stopReason,
        content: [{ type }],
        usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 },
      },
    })
    await fs.writeFile(path.join(project, "session-final.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "session-final", timestamp: new Date(observedAt - 1_000).toISOString(), message: { role: "user", content: "fix it" } }),
      block(0, "thinking", 2, null),
      block(1_000, "tool_use", 2, null),
      block(9_000, "tool_use", 1_066, "tool_use"),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 60_000,
      sources: ["claude"],
      classify: () => "external",
    })

    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]).toMatchObject({
      turnCount: 1,
      tokens: { input: 2, output: 1_066, cacheRead: 500, cacheWrite: 40 },
    })
  })

  test("counts one Claude turn per typed prompt however many requests answer it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-claude-turns-"))
    roots.push(root)
    const project = path.join(root, ".claude", "projects", "fixture")
    await fs.mkdir(project, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 23, 3, 0, 0)
    const at = (offset: number) => new Date(observedAt + offset).toISOString()
    const user = (offset: number, content: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "user", sessionId: "session-turns", timestamp: at(offset), message: { role: "user", content }, ...extra })
    const response = (offset: number, id: string, model = "claude-opus-5-5") => JSON.stringify({
      type: "assistant",
      sessionId: "session-turns",
      requestId: `req_${id}`,
      timestamp: at(offset),
      message: { id, role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text" }], usage: { input_tokens: 1, output_tokens: 10 } },
    })
    await fs.writeFile(path.join(project, "session-turns.jsonl"), [
      user(0, "first prompt"),
      response(1_000, "msg_a"),
      user(2_000, [{ type: "tool_result", tool_use_id: "t" }], { toolUseResult: { stdout: "" } }),
      response(3_000, "msg_b"),
      user(4_000, "Caveat: local command output follows", { isMeta: true }),
      user(5_000, "second prompt"),
      JSON.stringify({
        type: "assistant", sessionId: "session-turns", timestamp: at(6_000),
        message: { id: "msg_synthetic", role: "assistant", model: "<synthetic>", content: [{ type: "text" }], usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      response(7_000, "msg_c"),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 60_000,
      sources: ["claude"],
      classify: () => "external",
    })

    expect(snapshot.rows.map((row) => row.model)).toEqual(["claude-opus-5-5"])
    expect(snapshot.rows[0]).toMatchObject({ turnCount: 2, tokens: { input: 3, output: 30 } })
  })

  describe("Claude rows that open a turn", () => {
    const observedAt = Date.UTC(2026, 8, 23, 5, 0, 0)
    const at = (offset: number) => new Date(observedAt + offset).toISOString()
    const user = (offset: number, content: unknown, extra: Record<string, unknown> = {}) =>
      ({ type: "user", sessionId: "session-kinds", timestamp: at(offset), message: { role: "user", content }, ...extra })
    const prompt = (offset: number, text: string) => user(offset, text, { origin: { kind: "human" }, promptSource: "sdk" })
    const response = (offset: number, id: string, extra: Record<string, unknown> = {}) => ({
      type: "assistant",
      sessionId: "session-kinds",
      requestId: `req_${id}`,
      timestamp: at(offset),
      message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text" }], usage: { input_tokens: 1, output_tokens: 10 } },
      ...extra,
    })

    async function turnsFor(files: Record<string, unknown[]>) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-claude-kinds-"))
      roots.push(root)
      const project = path.join(root, ".claude", "projects", "fixture")
      for (const [name, rows] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(project, name)), { recursive: true })
        await fs.writeFile(path.join(project, name), rows.map((row) => JSON.stringify(row)).join("\n"))
      }
      const snapshot = await scanTokenTrackerLocalHistory({
        sourceHome: root,
        stateDir: path.join(root, "state"),
        since: observedAt - 60_000,
        until: observedAt + 60_000,
        sources: ["claude"],
        classify: () => "external",
      })
      return snapshot.rows.reduce((sum, row) => sum + row.turnCount, 0)
    }

    test.each([
      ["a task notification", [user(2_000, "<task-notification>done</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system" })]],
      ["a system-sourced prompt", [user(2_000, "scheduled wake-up", { promptSource: "system" })]],
      ["a local command and its output", [
        user(2_000, "<local-command-caveat>Caveat: generated by local commands</local-command-caveat>", { isMeta: true }),
        user(2_100, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
        user(2_200, "<local-command-stdout>Set model to opus</local-command-stdout>"),
      ]],
      ["a compaction summary", [user(2_000, "This session is being continued from a previous conversation.", { isCompactSummary: true })]],
      ["a tool result", [user(2_000, [{ type: "tool_result", tool_use_id: "t" }], { toolUseResult: { stdout: "" } })]],
      ["a meta reminder", [user(2_000, "<system-reminder>background task finished</system-reminder>", { isMeta: true })]],
    ])("%s is not a turn", async (_kind, rows) => {
      expect(await turnsFor({
        "session-kinds.jsonl": [prompt(0, "first prompt"), response(1_000, "msg_a"), ...rows, response(3_000, "msg_b")],
      })).toBe(1)
    })

    test.each([
      ["a typed prompt", [prompt(2_000, "second prompt")]],
      ["a prompt a command sends to the model", [user(2_000, "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship it</command-args>")]],
    ])("%s is a turn", async (_kind, rows) => {
      expect(await turnsFor({
        "session-kinds.jsonl": [prompt(0, "first prompt"), response(1_000, "msg_a"), ...rows, response(3_000, "msg_b")],
      })).toBe(2)
    })

    test("a transcript no person prompted has no turn", async () => {
      expect(await turnsFor({
        "session-kinds.jsonl": [
          user(0, "<task-notification>scheduled review</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system" }),
          response(1_000, "msg_a"),
        ],
      })).toBe(0)
    })

    test("a subagent transcript is one turn of its own however many prompts it holds", async () => {
      const sidechain = { isSidechain: true, agentId: "agent-1" }
      expect(await turnsFor({
        "session-kinds.jsonl": [prompt(0, "delegate this"), response(1_000, "msg_parent")],
        "session-kinds/subagents/agent-1.jsonl": [
          user(1_100, "investigate the queue", sidechain),
          response(1_200, "msg_sub_a", sidechain),
          user(1_300, [{ type: "tool_result", tool_use_id: "t" }], { ...sidechain, toolUseResult: { stdout: "" } }),
          response(1_400, "msg_sub_b", sidechain),
          user(1_500, "and now the relay", sidechain),
          response(1_600, "msg_sub_c", sidechain),
        ],
      })).toBe(2)
    })
  })

  test("carries the one-hour share of Claude cache writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-claude-cache-ttl-"))
    roots.push(root)
    const project = path.join(root, ".claude", "projects", "fixture")
    await fs.mkdir(project, { recursive: true })
    const observedAt = Date.UTC(2026, 8, 23, 4, 0, 0)
    await fs.writeFile(path.join(project, "session-ttl.jsonl"), JSON.stringify({
      type: "assistant",
      sessionId: "session-ttl",
      requestId: "req_ttl",
      timestamp: new Date(observedAt).toISOString(),
      message: {
        id: "msg_ttl",
        role: "assistant",
        model: "claude-opus-5",
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
        },
      },
    }))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1,
      until: observedAt + 1,
      sources: ["claude"],
      classify: () => "external",
    })

    expect(snapshot.rows[0]?.tokens).toMatchObject({ cacheWrite: 100, cacheWrite1h: 70 })
  })

  test("reads Cursor SDK run stores and excludes Claxedo-launched agent ids", async () => {
    const { root, observedAt } = await fixture()
    const cursorRoot = path.join(root, ".cursor", "sdk")
    await fs.mkdir(cursorRoot, { recursive: true })
    const db = new Database(path.join(cursorRoot, "store.db"))
    db.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT, usage_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    )`)
    const insert = db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)")
    const at = new Date(observedAt).toISOString()
    insert.run("run-direct", "cursor-direct", "cursor-fast", JSON.stringify({
      inputTokens: 13, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1,
    }), at, at, at)
    insert.run("run-claxedo", "cursor-claxedo", "cursor-fast", JSON.stringify({
      inputTokens: 17, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0,
    }), at, at, at)
    db.close()

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1,
      until: observedAt + 1,
      sources: ["cursor"],
      classify: ({ nativeSessionId }) => nativeSessionId === "cursor-claxedo" ? "claxedo" : "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "cursor",
      nativeSessionId: "cursor-direct",
      model: "cursor-fast",
      tokens: { input: 13, output: 5, reasoning: null, cacheRead: 2, cacheWrite: 1, cacheWrite1h: null },
    })])
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.coverage).toEqual([{ source: "cursor", status: "available" }])
  })
})
