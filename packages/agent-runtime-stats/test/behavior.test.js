import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { analyzeSessions } from "../src/analyze.js"
import { classifyToolCall } from "../src/classify.js"
import { homeDirectory, parseArgs } from "../src/cli.js"
import { createScanProgress } from "../src/progress.js"
import { renderTable, sharePrompt } from "../src/render.js"

function call(id, name, input, start = 0, end = 0) {
  return { id, name, input, start, end, turn_id: "turn-1" }
}

test("classifies calls by minimum runtime", () => {
  assert.equal(classifyToolCall(call("1", "apply_patch", {})).tier, "bash")
  assert.equal(classifyToolCall(call("2", "shell", { command: "bun test" })).tier, "vm")
  assert.equal(classifyToolCall(call("3", "web_search", {})).tier, "bash")
  assert.equal(classifyToolCall(call("4", "update_plan", {})).tier, "control")
  assert.equal(classifyToolCall(call("5", "shell", { command: "curl https://example.com | python3" })).tier, "vm")
  assert.equal(
    classifyToolCall(call("6", "shell", { command: "wget https://example.com/app.zip && unzip app.zip" })).tier,
    "vm",
  )
  assert.equal(classifyToolCall(call("7", "docker", { command: "docker build ." })).tier, "vm")
  assert.equal(classifyToolCall(call("8", "shell", { command: "gh pr checkout 123" })).tier, "vm")
  assert.equal(classifyToolCall(call("9", "shell", { command: "gh api repos/openai/codex" })).tier, "bash")
  assert.equal(
    classifyToolCall(call("10", "shell", { command: "gh api repos/openai/codex && gh pr checkout 123" })).tier,
    "vm",
  )
  assert.equal(classifyToolCall(call("11", "shell", { command: "gh api repos/openai/codex && fly deploy" })).tier, "vm")
  assert.equal(
    classifyToolCall(call("12", "shell", { command: 'grep -n "playwright" packages/e2e/playwright/test.ts' })).tier,
    "bash",
  )
  assert.equal(classifyToolCall(call("13", "shell", { command: "kubectl apply -f deploy.yaml" })).tier, "vm")
  assert.equal(classifyToolCall(call("14", "shell", { command: "echo ready && git status" })).tier, "vm")
  assert.equal(classifyToolCall(call("15", "shell", { command: "$RUNNER test" })).tier, "unknown")
  assert.deepEqual(classifyToolCall(call("16", "shell", { command: "python3 generated.py" })), {
    tier: "vm",
    bucket: "generated code execution*",
  })
  assert.equal(classifyToolCall(call("17", "shell", { command: "sqlite3 data.db '.tables'" })).tier, "bash")
  assert.equal(classifyToolCall(call("18", "shell", { command: "xargs node" })).tier, "vm")
  assert.equal(classifyToolCall(call("18b", "shell", { command: "xargs -0 -n 1 echo" })).tier, "bash")
  assert.deepEqual(classifyToolCall(call("19", "shell", { command: "./generated-program" })), {
    tier: "vm",
    bucket: "generated code execution*",
  })
  assert.equal(classifyToolCall({ ...call("20", "exec", "ls"), harness: "claude" }).tier, "bash")
  assert.equal(classifyToolCall(call("21", "shell", { command: "cat <<'EOF'\nnode is text\nEOF" })).tier, "bash")
  assert.equal(classifyToolCall(call("22", "shell", { command: "echo $(node -e '1 + 1')" })).tier, "vm")
  assert.equal(classifyToolCall(call("23", "shell", { command: "time node generated.js" })).tier, "vm")
  assert.equal(classifyToolCall(call("24", "shell", { command: "env -u DEBUG echo ready" })).tier, "bash")
  assert.equal(classifyToolCall(call("25", "shell", { command: "sudo echo ready" })).tier, "vm")
  assert.equal(classifyToolCall(call("26", "shell", { command: "eval 'echo generated'" })).tier, "vm")
  for (const name of [
    "TaskUpdate",
    "Agent",
    "SendMessage",
    "StructuredOutput",
    "TodoWrite",
    "question",
    "Skill",
    "EnterPlanMode",
  ]) {
    assert.equal(classifyToolCall(call(name, name, {})).tier, "control")
  }
})

test("measures local full-machine demand without estimating environment readiness", () => {
  const sessions = [
    {
      id: "feature",
      harness: "codex",
      calls: [
        call("1", "apply_patch", {}, 0, 1000),
        call("2", "shell", { command: "git status" }, 5000, 7000),
        call("3", "shell", { command: "bun test" }, 17000, 21000),
        call("4", "shell", { command: "docker build ." }, 50000, 55000),
        call("5", "shell", { command: "python3 script.py" }, 100000, 106000),
      ],
    },
    { id: "docs", harness: "claude", calls: [call("6", "apply_patch", {}, 0, 1000)] },
    { id: "empty", harness: "cursor", calls: [] },
  ]
  const result = analyzeSessions(sessions)
  assert.equal(result.sessions.total, 3)
  assert.equal(result.sessions.with_execution_calls, 2)
  assert.equal(result.sessions.requiring_full_machine, 1)
  assert.equal(result.sessions.just_bash_only, 1)
  assert.equal(result.sessions.unresolved_runtime_only, 0)
  assert.equal(result.sessions.without_execution_calls, 1)
  assert.deepEqual(result.turns, {
    total: 2,
    requiring_full_machine: 1,
    just_bash_only: 1,
    unresolved_runtime_only: 0,
    execution_calls_covered: 6,
    with_repeated_full_machine_calls: 1,
    with_resolved_runtime: 2,
  })
  assert.deepEqual(result.full_machine_demand.calls_per_requiring_session, {
    samples: 1,
    median: 4,
    p95: 4,
  })
  assert.deepEqual(result.full_machine_demand.first_call_lead, {
    samples: 1,
    median_ms: 5000,
    p95_ms: 5000,
  })
  assert.deepEqual(result.full_machine_demand.call_duration, {
    samples: 4,
    median_ms: 4500,
    p95_ms: 5850,
  })
  assert.equal(result.full_machine_demand.time_between_calls.samples, 3)
  assert.equal(result.full_machine_demand.time_between_calls.median_ms, 29000)
  assert.equal(result.full_machine_demand.time_between_calls.p95_ms, 43400)
  assert.deepEqual(result.full_machine_demand.time_between_calls.longer_than, {
    "30000_ms": { count: 1, percent: 100 / 3 },
    "60000_ms": { count: 0, percent: 0 },
    "120000_ms": { count: 0, percent: 0 },
  })
  assert.deepEqual(result.full_machine_demand.calls_after_first_full_machine, {
    samples: 1,
    median: 3,
    p95: 3,
  })
  assert.deepEqual(result.full_machine_demand.observed_span_after_first_full_machine, {
    samples: 1,
    median_ms: 101000,
    p95_ms: 101000,
  })
  assert.equal("environment_readiness" in result, false)
})

test("keeps unresolved runtime calls out of both headline tiers", () => {
  const result = analyzeSessions([
    { id: "unknown", harness: "claude", calls: [call("1", "mystery_tool", {})] },
    { id: "known", harness: "codex", calls: [call("2", "apply_patch", {})] },
  ])
  assert.deepEqual(result.calls, { total: 2, bash: 1, vm: 0, unknown: 1 })
  assert.equal(result.sessions.unresolved_runtime_only, 1)
  assert.equal(result.sessions.just_bash_only, 1)
})

test("excludes invalid and unfinished timestamps from duration and gap samples", () => {
  const sessions = [
    {
      id: "timing",
      harness: "codex",
      calls: [
        call("1", "shell", { command: "git status" }, Number.NaN, Number.POSITIVE_INFINITY),
        call("2", "shell", { command: "bun test" }, 1000, null),
        call("3", "shell", { command: "bun test" }, 5000, 6000),
        call("4", "shell", { command: "bun test" }, 10000, 11000),
      ],
    },
  ]
  const result = analyzeSessions(sessions)
  assert.deepEqual(result.full_machine_demand.call_duration, {
    samples: 2,
    median_ms: 1000,
    p95_ms: 1000,
  })
  assert.equal(result.full_machine_demand.time_between_calls.samples, 0)
  assert.equal(result.full_machine_demand.first_call_lead.samples, 1)
})

test("renders the report as terminal tables", () => {
  const analysis = analyzeSessions([])
  analysis.sources = [
    {
      harness: "cursor",
      status: "partial",
      stores: 1,
      note: "Some proprietary records are unavailable.",
    },
  ]
  const output = renderTable(analysis)
  assert.match(output, /Median full-machine interval/)
  assert.match(output, /p95 full-machine interval/)
  assert.match(output, /Observed just-bash-only sessions/)
  assert.match(output, /Sessions without observed execution calls/)
  assert.match(output, /Median first-call lead/)
  assert.match(output, /Median full-machine call duration/)
  assert.match(output, /Gaps longer than 120s/)
  assert.match(output, /ENVIRONMENT READINESS/)
  assert.match(output, /Not measured here/)
  assert.match(output, /Can run in just-bash/)
  assert.match(output, /Runtime unresolved/)
  assert.match(output, /Generated code execution is counted as full-machine/)
  assert.doesNotMatch(output, /workerd/i)
  assert.doesNotMatch(output, /CI\/E2E/)
  assert.match(output, /PARTIAL COVERAGE/)
  assert.match(output, /cursor:/)
  assert.match(output, /No transcript sessions were found/)
  assert.doesNotMatch(output, /Harness.*Status.*Stores/)
})

test("derives source caveats and suppresses empty-report sharing", () => {
  const analysis = analyzeSessions([])
  const output = renderTable(analysis)
  assert.doesNotMatch(output, /Partial coverage/)
  assert.doesNotMatch(output, /100%/)
  assert.equal(sharePrompt(analysis, "https://stats.example"), null)
  assert.equal(sharePrompt(analyzeSessions([{ id: "s", harness: "codex", calls: [call("1", "read", {})] }])), null)
})

test("keeps report lines within wide, compact, and narrow terminals", () => {
  const analysis = analyzeSessions([
    { id: "feature", harness: "codex", calls: [call("1", "shell", { command: "bun test" })] },
  ])
  for (const columns of [160, 120, 80, 50, 20]) {
    const output = renderTable(analysis, columns)
    assert.match(output, /^┌/)
    assert.match(output, /└[^\n]*┘\n\nNOTES/)
    assert.doesNotMatch(output, /^Sessions analyzed.*:/m)
    assert.ok(Math.max(...output.split("\n").map((line) => line.length)) <= columns, `exceeded ${columns} columns`)
    if (columns === 50) {
      const normalized = output.replace(/\s+/g, " ")
      assert.match(normalized, /100\.00% of .*resolved sessions/)
      assert.match(normalized, /1 turn/)
      assert.doesNotMatch(normalized, /of tier/)
    }
  }
  const longToken = { ...analysis, sources: [{ harness: "x".repeat(80), status: "partial", stores: 1 }] }
  assert.ok(
    Math.max(
      ...renderTable(longToken, 20)
        .split("\n")
        .map((line) => line.length),
    ) <= 20,
  )

  const colored = renderTable(analysis, 80, true)
  assert.match(colored, /\u001B\[1;36m/)
  assert.match(colored, /\u001B\[90m/)
  assert.match(colored, /\u001B\[33m/)
  const plain = colored.replace(/\u001B\[[0-9;]*m/g, "")
  assert.ok(Math.max(...plain.split("\n").map((line) => line.length)) <= 80)
  assert.doesNotMatch(renderTable(analysis, 80), /\u001B\[/)
})

test("shows live scan progress only in interactive terminals", () => {
  const output = []
  let tick
  let now = 0
  let cancelled = false
  const stream = { isTTY: true, write: (value) => output.push(value) }
  const progress = createScanProgress(stream, 10, {
    now: () => now,
    setInterval: (callback) => {
      tick = callback
      return { unref() {} }
    },
    clearInterval: () => {
      cancelled = true
    },
  })
  progress.update({ completed: 3, harness: "claude" })
  now = 1250
  tick()
  progress.stop()
  const rendered = output.join("")
  assert.match(rendered, /3\/10 · 1\.3s · claude/)
  assert.match(rendered, /✓ Scanned 3 transcript stores in 1\.3s/)
  assert.match(rendered, /\u001B\[\?25l/)
  assert.match(rendered, /\u001B\[\?25h/)
  assert.equal(cancelled, true)

  const plain = []
  const nonInteractive = createScanProgress({ isTTY: false, write: (value) => plain.push(value) }, 10)
  nonInteractive.update({ completed: 10, harness: "codex" })
  nonInteractive.stop(2)
  assert.deepEqual(plain, [
    "Scanning 10 local transcript stores…\n",
    "Scanned 10 transcript stores in 0.0s · 2 read errors\n",
  ])
})

test("CLI suppresses Node's SQLite experimental warning", () => {
  const binary = fileURLToPath(new URL("../bin/agent-runtime-stats.js", import.meta.url))
  const result = spawnSync(process.execPath, [binary, "--version"], { encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/)
})

test("CLI rejects unknown harnesses and does not share empty reports", () => {
  const binary = fileURLToPath(new URL("../bin/agent-runtime-stats.js", import.meta.url))
  const invalid = spawnSync(process.execPath, [binary, "--harness", "codx"], { encoding: "utf8" })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Unknown harness: codx.*codex/)

  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "agent-runtime-empty-"))
  const empty = spawnSync(process.execPath, [binary, "--home", emptyHome], {
    encoding: "utf8",
    env: { ...process.env, AGENT_RUNTIME_STATS_SHARE_URL: "https://stats.example" },
  })
  assert.equal(empty.status, 0)
  assert.match(empty.stdout, /No transcript sessions were found/)
  assert.doesNotMatch(empty.stdout, /Share these anonymous aggregate stats/)
  assert.doesNotMatch(empty.stdout, /100%/)
})

test("CLI has no default share endpoint", () => {
  const binary = fileURLToPath(new URL("../bin/agent-runtime-stats.js", import.meta.url))
  const fixtureHome = mkdtempSync(path.join(os.tmpdir(), "agent-runtime-share-"))
  const sessions = path.join(fixtureHome, ".codex", "sessions")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    path.join(sessions, "fixture.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: "{}" },
    })}\n`,
  )
  const environment = { ...process.env }
  delete environment.AGENT_RUNTIME_STATS_SHARE_URL
  const result = spawnSync(process.execPath, [binary, "--home", fixtureHome], {
    encoding: "utf8",
    env: environment,
  })
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout, /workers\.dev|Share these anonymous aggregate stats/)
})

test("parses cross-platform CLI paths", () => {
  const options = parseArgs(["--harness", "codex,claude", "--path", "codex=fixtures", "--format", "json"], "/workspace")
  assert.deepEqual(options.selected, ["codex", "claude"])
  assert.equal(options.paths.get("codex")[0], path.resolve("/workspace", "fixtures"))
  assert.equal(options.format, "json")
  assert.throws(() => parseArgs(["--harness", "codx"]), /Unknown harness: codx.*codex/)
  assert.throws(() => parseArgs(["--path", "codx=fixtures"]), /Unknown harness: codx/)
})

test("resolves Unix and Windows home environment variables", () => {
  assert.equal(homeDirectory(null, { HOME: "/Users/me", USERPROFILE: "C:\\Users\\me" }), "/Users/me")
  assert.equal(homeDirectory(null, { USERPROFILE: "C:\\Users\\me" }), "C:\\Users\\me")
  assert.equal(homeDirectory(null, { HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me" }), "C:\\Users\\me")
})

test("share prompt carries only canonical aggregate metrics and becomes clickable in terminals", () => {
  const analysis = analyzeSessions([
    { id: "feature", harness: "codex", calls: [call("1", "apply_patch", {}), call("2", "web_search", {})] },
  ])
  const plain = sharePrompt(analysis, "https://stats.example/")
  const url = plain.split("\n")[1]
  const payload = JSON.parse(Buffer.from(url.split("#data=")[1], "base64url").toString())

  assert.deepEqual(Object.keys(payload), [
    "schemaVersion",
    "sessionsAnalyzed",
    "executionCalls",
    "sessionsWithoutFullMachinePercent",
    "turnsAnalyzed",
    "turnCoveragePercent",
    "turnsWithoutFullMachinePercent",
    "repeatFullMachineTurnPercent",
    "medianCallsAfterFirstFullMachine",
    "medianObservedSpanAfterFirstFullMachineMs",
    "p95ObservedSpanAfterFirstFullMachineMs",
  ])
  assert.equal(payload.sessionsAnalyzed, 1)
  assert.equal(payload.executionCalls, 2)
  assert.equal(payload.sessionsWithoutFullMachinePercent, 100)
  assert.equal(payload.turnsAnalyzed, 1)
  assert.equal(payload.turnCoveragePercent, 100)
  assert.equal(payload.turnsWithoutFullMachinePercent, 100)
  assert.equal(payload.repeatFullMachineTurnPercent, null)
  assert.equal(payload.medianCallsAfterFirstFullMachine, null)
  assert.equal(payload.medianObservedSpanAfterFirstFullMachineMs, null)
  assert.equal(payload.p95ObservedSpanAfterFirstFullMachineMs, null)
  assert.equal(payload.schemaVersion, 2)
  const escape = String.fromCharCode(27)
  const interactive = sharePrompt(analysis, "https://stats.example", true)
  assert.equal(plain.includes(escape), false)
  assert.equal(interactive.includes(`${escape}]8;;https://stats.example/share#data=`), true)
  assert.match(interactive, /\[ Share results \]/)
})
