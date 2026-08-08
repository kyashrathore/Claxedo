import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parseJsonFile, parseJsonlFile } from "../src/parsers.js"
import { discoverSources } from "../src/sources.js"

async function jsonlFixture(rows) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-stats-"))
  const file = path.join(directory, "session.jsonl")
  await writeFile(file, `${rows.map(JSON.stringify).join("\n")}\n`)
  return file
}

test("parses Codex call and completion timestamps", async () => {
  const file = await jsonlFixture([
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1" } },
    { timestamp: "2026-01-01T00:00:01.000Z", type: "turn_context", payload: { turn_id: "t1" } },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"git status"}' },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1" },
    },
  ])
  const { session } = await parseJsonlFile("codex", file)
  assert.equal(session.id, "s1")
  assert.equal(session.calls[0].turn_id, "t1")
  assert.equal(session.calls[0].end - session.calls[0].start, 1000)
  assert.equal(session.calls[0].classification.tier, "vm")
})

test("preserves missing tool completion timestamps", async () => {
  const file = await jsonlFixture([
    { timestamp: "2026-01-01T00:00:00.000Z", type: "turn_context", payload: { turn_id: "t1" } },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"bun test"}' },
    },
  ])
  const { session } = await parseJsonlFile("codex", file)
  assert.equal(session.calls[0].end, null)
})

test("parses Claude and Kimi tool results", async () => {
  const claudeFile = await jsonlFixture([
    {
      type: "user",
      uuid: "u1",
      sessionId: "s2",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "implement" },
    },
    {
      type: "assistant",
      sessionId: "s2",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "bun test" } }],
      },
    },
    {
      type: "user",
      sessionId: "s2",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1" }] },
    },
  ])
  assert.equal(
    (await parseJsonlFile("claude", claudeFile)).session.calls[0].end,
    Date.parse("2026-01-01T00:00:02.000Z"),
  )

  const kimiFile = await jsonlFixture([
    { role: "user", id: "u1", timestamp: 1700000000000 },
    {
      role: "assistant",
      timestamp: 1700000001000,
      tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"command":"git status"}' } }],
    },
    { role: "tool", timestamp: 1700000002000, tool_call_id: "c1" },
  ])
  assert.equal((await parseJsonlFile("kimi", kimiFile)).session.calls[0].end, 1700000002000)
})

test("parses Gemini embedded tool calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-stats-"))
  const file = path.join(directory, "session.json")
  await writeFile(
    file,
    JSON.stringify({
      sessionId: "s3",
      messages: [
        { id: "u1", type: "user", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "gemini",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [
            { id: "c1", name: "grep_search", args: { pattern: "agent-hook" }, status: "success", result: [] },
          ],
        },
      ],
    }),
  )
  const { session } = parseJsonFile("gemini", file)
  assert.equal(session.id, "s3")
  assert.equal(session.calls[0].name, "grep_search")
  assert.equal(session.calls[0].turn_id, "u1")
  assert.equal(session.calls[0].end, null)
})

test("discovers OpenCode under XDG_DATA_HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-home-"))
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-data-"))
  await mkdir(path.join(dataHome, "opencode"))
  await writeFile(path.join(dataHome, "opencode", "opencode.db"), "")
  const [source] = discoverSources(home, dataHome, ["opencode"])
  assert.equal(source.status, "ready")
  assert.equal(source.files.length, 1)
})
