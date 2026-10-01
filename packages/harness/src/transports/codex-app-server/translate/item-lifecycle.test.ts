import { expect, test } from "bun:test"
import { translatorRuntime } from "../../../test-support/translator-runtime"
import { codexAppServerAdapter } from "./adapter"

function runtime() {
  return translatorRuntime({
    harness: "codex-app-server",
    threadId: "thread-1",
    adapter: codexAppServerAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  })
}

function item(agent: ReturnType<typeof runtime>, method: "item/started" | "item/completed", value: Record<string, unknown>) {
  return agent.ingest({ source: "codex.app-server", method, payload: { threadId: "thread-1", turnId: "turn-1", item: value } }).events
}

test("a native subagent interaction or interruption names the agent it touched", () => {
  for (const kind of ["interacted", "interrupted"]) {
    const agent = runtime()
    const activity = { type: "subAgentActivity", id: `call-${kind}`, kind, agentThreadId: "child-thread", agentPath: "/root/state_review" }
    expect(item(agent, "item/started", activity)).toMatchObject([
      { type: "tool-start", toolCallId: `call-${kind}`, toolName: `subagent_${kind}`, kind: "subagent_activity" },
      { type: "tool-input", toolCallId: `call-${kind}`, input: { agentPath: "/root/state_review", agentThreadId: "child-thread" } },
    ])
    expect(item(agent, "item/completed", activity)).toMatchObject([{ type: "tool-output", toolCallId: `call-${kind}` }])
  }
})

test("a hook's injected prompt is shown on its row", () => {
  const hookPrompt = {
    type: "hookPrompt",
    id: "msg-hook-1",
    fragments: [
      { text: "Pick the next concrete work item yourself and do it now.", hookRunId: "stop:7:/repo/.codex/hooks.json" },
      { text: "Then explain your next task.", hookRunId: "stop:7:/repo/.codex/hooks.json" },
    ],
  }
  expect(item(runtime(), "item/completed", hookPrompt)).toMatchObject([
    { type: "tool-start", toolCallId: "msg-hook-1", toolName: "hook_prompt", kind: "hook_prompt" },
    {
      type: "tool-input",
      input: { prompt: "Pick the next concrete work item yourself and do it now.\n\nThen explain your next task.", hookRunIds: ["stop:7:/repo/.codex/hooks.json"] },
      display: { description: "Pick the next concrete work item yourself and do it now.\n\nThen explain your next task." },
    },
    { type: "tool-output", toolCallId: "msg-hook-1", output: "" },
  ])
})

test("a sleep row carries its duration", () => {
  expect(item(runtime(), "item/started", { type: "sleep", id: "sleep-1", durationMs: 5000 })).toMatchObject([
    { type: "tool-start", toolCallId: "sleep-1", toolName: "sleep", kind: "sleep" },
    { type: "tool-input", toolCallId: "sleep-1", input: { durationMs: 5000 } },
  ])
})

test("a generated image is an image attachment, never base64 text", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ=="
  const agent = runtime()
  expect(item(agent, "item/started", { type: "imageGeneration", id: "ig-1", status: "in_progress", revisedPrompt: null, result: "", failure: null }))
    .toMatchObject([{ type: "tool-start", toolCallId: "ig-1", toolName: "image_generation", kind: "image_generation" }])
  const completed = item(agent, "item/completed", {
    type: "imageGeneration", id: "ig-1", status: "completed", revisedPrompt: "a red cube", result: png, failure: null, savedPath: "/tmp/ig-1.png",
  })
  expect(completed.at(-1)).toMatchObject({
    type: "tool-output", toolCallId: "ig-1", output: "a red cube",
    attachments: [{ kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}` }],
  })
  expect(JSON.stringify(completed.at(-1))).not.toContain(`"output":"${png}`)
})

test("a generated image too large to keep inline points at the file Codex saved", () => {
  const large = `iVBORw0KGgo${"A".repeat(200_000)}`
  const completed = item(runtime(), "item/completed", {
    type: "imageGeneration", id: "ig-2", status: "completed", revisedPrompt: null, result: large, failure: null, savedPath: "/tmp/ig-2.png",
  })
  expect(completed.at(-1)).toMatchObject({ type: "tool-output", output: "", attachments: [{ kind: "tool-file", mime: "image/png", path: "/tmp/ig-2.png", filename: "ig-2.png" }] })
})

test("an image generation refused for usage is an error", () => {
  const completed = item(runtime(), "item/completed", {
    type: "imageGeneration", id: "ig-3", status: "failed", revisedPrompt: null, result: "", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: null },
  })
  expect(completed.at(-1)).toMatchObject({ type: "tool-error", toolCallId: "ig-3", error: "Image generation stopped: usage limit reached" })
})

const change = { path: "/repo/src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }
const added = { path: "/repo/src/new.ts", kind: { type: "add" }, diff: "+export {}\n" }

test("a file change names its files and carries their diffs", () => {
  const agent = runtime()
  expect(item(agent, "item/started", { type: "fileChange", id: "patch-1", status: "inProgress", changes: [change, added] })).toMatchObject([
    { type: "tool-start", toolCallId: "patch-1", toolName: "apply_patch", kind: "file_change", metadata: { files: [
      { filePath: "/repo/src/app.ts", type: "update", diff: change.diff },
      { filePath: "/repo/src/new.ts", type: "add", diff: added.diff },
    ] } },
    { type: "tool-input", toolCallId: "patch-1", input: { files: ["/repo/src/app.ts", "/repo/src/new.ts"] } },
  ])
  expect(item(agent, "item/completed", { type: "fileChange", id: "patch-1", status: "completed", changes: [change, added] }).at(-1))
    .toMatchObject({ type: "tool-output", toolCallId: "patch-1", metadata: { files: [{ filePath: "/repo/src/app.ts" }, { filePath: "/repo/src/new.ts" }] } })
})

test("a renamed file keeps where it moved to", () => {
  const moved = { path: "/repo/a.ts", kind: { type: "update", move_path: "/repo/b.ts" }, diff: "" }
  expect(item(runtime(), "item/completed", { type: "fileChange", id: "patch-2", status: "completed", changes: [moved] })[0])
    .toMatchObject({ metadata: { files: [{ filePath: "/repo/a.ts", type: "move", movePath: "/repo/b.ts" }] } })
})

test("a declined or failed patch is an error, never a success", () => {
  for (const [status, error] of [["declined", "User declined the file change"], ["failed", "The file change failed to apply"]]) {
    const agent = runtime()
    item(agent, "item/started", { type: "fileChange", id: "patch-3", status: "inProgress", changes: [change] })
    expect(item(agent, "item/completed", { type: "fileChange", id: "patch-3", status, changes: [change] }))
      .toMatchObject([{ type: "tool-error", toolCallId: "patch-3", error }])
  }
})

test("a failed collab tool call is an error naming the tool", () => {
  const call = { type: "collabAgentToolCall", id: "collab-1", tool: "sendInput", senderThreadId: "thread-1", receiverThreadIds: ["thread-2"],
    prompt: "Keep going", model: null, reasoningEffort: null, agentsStates: {} }
  const agent = runtime()
  item(agent, "item/started", { ...call, status: "inProgress" })
  expect(item(agent, "item/completed", { ...call, status: "failed" }).at(-1)).toMatchObject({ type: "tool-error", toolCallId: "collab-1", error: "sendInput failed" })
})

test("a web search row carries the query Codex settled on and its results", () => {
  const agent = runtime()
  expect(item(agent, "item/started", { type: "webSearch", id: "ws-1", query: "", action: null, results: null })).toMatchObject([
    { type: "tool-start", toolCallId: "ws-1", toolName: "web_search", kind: "web_search" },
  ])
  const results = [{ type: "text_result", title: "Overview | Cursor Docs", url: "https://cursor.com/docs/agent/overview" }]
  expect(item(agent, "item/completed", {
    type: "webSearch", id: "ws-1", query: "cursor agent read image tool",
    action: { type: "search", query: null, queries: ["cursor agent read image tool", "codex view_image"] }, results,
  })).toMatchObject([
    { type: "tool-input", toolCallId: "ws-1", input: { query: "cursor agent read image tool" }, display: { query: "cursor agent read image tool" } },
    { type: "tool-output", toolCallId: "ws-1", output: results },
  ])
})

test("a web search that only names its queries in the action still has a query", () => {
  expect(item(runtime(), "item/completed", {
    type: "webSearch", id: "ws-2", query: "", action: { type: "search", queries: ["bun sqlite", "node sqlite"] }, results: null,
  })).toMatchObject([
    { type: "tool-start", toolCallId: "ws-2" },
    { type: "tool-input", input: { query: "bun sqlite | node sqlite" } },
    { type: "tool-output", output: "" },
  ])
  expect(item(runtime(), "item/completed", {
    type: "webSearch", id: "ws-3", query: "", action: { type: "open_page", url: "https://example.test/page" }, results: null,
  })).toMatchObject([{ type: "tool-start" }, { type: "tool-input", input: { url: "https://example.test/page" } }, { type: "tool-output" }])
})
