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
      classificationKey: "fixture-overlap-v1",
      classify,
    })
    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "claude",
      nativeSessionId: "direct",
      tokens: { input: 10, output: 20, reasoning: null, cacheRead: 3, cacheWrite: null },
    })])
    expect(snapshot.totalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeSessionId: "direct" }),
      expect.objectContaining({ nativeSessionId: "native-claxedo" }),
    ]))
    expect(snapshot.totalRows).toHaveLength(2)
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.unclassified).toBe(0)
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
      classificationKey: "fixture-unclassified-total-v1",
      classify: () => "unclassified",
    })

    expect(snapshot.rows).toEqual([])
    expect(snapshot.totalRows).toHaveLength(2)
    expect(snapshot.unclassified).toBe(2)
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
      classificationKey: "fixture-direct-v1",
      classify,
    }
    const [first, concurrent] = await Promise.all([
      scanTokenTrackerLocalHistory(input),
      scanTokenTrackerLocalHistory(input),
    ])
    expect(concurrent).toEqual(first)
    expect(classify).toHaveBeenCalledTimes(2)

    classify.mockClear()
    await expect(scanTokenTrackerLocalHistory(input)).resolves.toEqual(first)
    expect(classify).not.toHaveBeenCalled()
    await expect(scanTokenTrackerLocalHistory({ ...input, refresh: true })).resolves.toEqual(first)
    expect(classify).toHaveBeenCalledTimes(2)

    const cursorText = gunzipSync(await fs.readFile(path.join(stateDir, "embedded-history-cursors-v8.json.gz"))).toString("utf8")
    const cursor = JSON.parse(cursorText) as { version: number; files: Record<string, unknown> }
    expect(cursor.version).toBe(8)
    expect(Object.keys(cursor.files)).toHaveLength(2)
    expect(Object.keys(cursor.files).every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true)
    expect(cursorText).not.toContain(root)
    expect(cursorText).not.toContain("secret-project")
    expect(cursorText).not.toContain("private response")
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
      classificationKey: "fixture-incremental-v1",
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
      classificationKey: "fixture-corrupt-v1",
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
      classificationKey: "fixture-codex-deltas-v1",
      classify: () => "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "codex",
      provider: "openai",
      nativeSessionId: "codex-direct",
      model: "gpt-5.6-sol",
      tokens: { input: 70, output: 22, reasoning: 8, cacheRead: 80, cacheWrite: 0 },
    })])
    const totals = snapshot.rows[0]!.tokens
    expect((totals.input ?? 0) + (totals.output ?? 0) + (totals.reasoning ?? 0) + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0)).toBe(180)
  })

  test.each([
    { label: "forked_from_id", forkMarker: { forked_from_id: "codex-parent" } },
    {
      label: "subagent thread_spawn",
      forkMarker: { source: { subagent: { thread_spawn: { parent_thread_id: "codex-parent" } } } },
    },
  ])("counts copied parent history only once for a Codex $label rollout", async ({ label, forkMarker }) => {
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
      payload: { type: "agent_message", message: "done" },
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
      classificationKey: `fixture-codex-fork-history-${label}-v1`,
      classify: () => "external",
    })

    expect(snapshot.totalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeSessionId: "codex-parent",
        turnCount: 1,
        tokens: { input: 40, output: 20, reasoning: 0, cacheRead: 60, cacheWrite: 0 },
      }),
      expect.objectContaining({
        nativeSessionId: "codex-child",
        turnCount: 1,
        tokens: { input: 30, output: 10, reasoning: 0, cacheRead: 20, cacheWrite: 0 },
      }),
    ]))
    expect(snapshot.totalRows).toHaveLength(2)
  })

  test("counts completed Codex responses instead of intermediate token snapshots", async () => {
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
        timestamp: new Date(observedAt + 2_000).toISOString(),
        type: "event_msg",
        payload: { type: "agent_message", message: "done" },
      }),
    ].join("\n"))

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 60_000,
      until: observedAt + 3_000,
      sources: ["codex"],
      classificationKey: "fixture-codex-identical-turns-v1",
      classify: () => "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      nativeSessionId: "codex-identical",
      turnCount: 1,
      tokens: { input: 80, output: 28, reasoning: 12, cacheRead: 120, cacheWrite: 0 },
    })])
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
      classificationKey: "fixture-claude-global-dedupe-v1",
      classify: () => "external",
    })

    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]?.provider).toBe("anthropic")
    expect(snapshot.rows[0]?.tokens).toMatchObject({ input: 10, output: 2, cacheRead: 100 })
  })

  test("reads legacy and SQLite OpenCode histories before provenance aggregation", async () => {
    const { root, observedAt } = await fixture()
    const storage = path.join(root, ".local", "share", "opencode")
    const legacy = path.join(storage, "storage", "message", "session-legacy")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "msg_legacy.json"), JSON.stringify({
      id: "msg_legacy",
      sessionID: "opencode-direct",
      role: "assistant",
      modelID: "gpt-5.4",
      time: { completed: observedAt },
      tokens: { input: 7, output: 2, reasoning: 1, cache: { read: 3 } },
    }))
    const db = new Database(path.join(storage, "opencode.db"))
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    insert.run("msg_db", "opencode-claxedo", observedAt, observedAt, JSON.stringify({
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      time: { completed: observedAt },
      tokens: { input: 11, output: 4, cache: { read: 5, write: 2 } },
    }))
    db.close()

    const snapshot = await scanTokenTrackerLocalHistory({
      sourceHome: root,
      stateDir: path.join(root, "state"),
      since: observedAt - 1,
      until: observedAt + 1,
      sources: ["opencode"],
      classificationKey: "fixture-opencode-v1",
      classify: ({ nativeSessionId }) => nativeSessionId === "opencode-claxedo" ? "claxedo" : "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "opencode",
      nativeSessionId: "opencode-direct",
      model: "gpt-5.4",
      tokens: { input: 7, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: null },
    })])
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.coverage).toEqual([{ source: "opencode", status: "available" }])
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
      classificationKey: "fixture-cursor-v1",
      classify: ({ nativeSessionId }) => nativeSessionId === "cursor-claxedo" ? "claxedo" : "external",
    })

    expect(snapshot.rows).toEqual([expect.objectContaining({
      app: "cursor",
      nativeSessionId: "cursor-direct",
      model: "cursor-fast",
      tokens: { input: 13, output: 5, reasoning: null, cacheRead: 2, cacheWrite: 1 },
    })])
    expect(snapshot.classifiedClaxedo).toBe(1)
    expect(snapshot.coverage).toEqual([{ source: "cursor", status: "available" }])
  })
})
