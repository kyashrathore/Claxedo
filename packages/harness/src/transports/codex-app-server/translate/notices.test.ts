import { expect, test } from "bun:test"
import { translatorRuntime } from "../../../test-support/translator-runtime"
import { codexAppServerAdapter } from "./adapter"

function ingest(method: string, payload: Record<string, unknown>) {
  const agent = translatorRuntime({
    harness: "codex-app-server",
    threadId: "thread-1",
    adapter: codexAppServerAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  })
  return { events: agent.ingest({ source: "codex.app-server", method, payload }).events, state: agent.state() }
}

function hookRun(status: string, entries: Array<{ kind: string; text: string }> = [], statusMessage: string | null = null) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    run: {
      id: "session-start:0:/home/.codex/hooks.json", eventName: "sessionStart", handlerType: "command", executionMode: "sync",
      scope: "thread", sourcePath: "/home/.codex/hooks.json", source: "user", displayOrder: 0, status, statusMessage,
      startedAt: 1789882793, completedAt: status === "running" ? null : 1789882793, durationMs: status === "running" ? null : 41, entries,
    },
  }
}

test("a hook that ran and said nothing records nothing", () => {
  expect(ingest("hook/started", hookRun("running")).events).toEqual([])
  expect(ingest("hook/completed", hookRun("completed")).events).toEqual([])
  expect(ingest("hook/completed", hookRun("completed", [{ kind: "context", text: "Repository uses bun." }])).events).toEqual([])
})

test("a hook that blocked, failed or warned is a notice naming what it said", () => {
  expect(ingest("hook/completed", hookRun("blocked", [{ kind: "feedback", text: "Prompt blocked by policy" }])).events).toMatchObject([{
    type: "harness-notice", code: "codex_app_server.hook_blocked", severity: "warn", message: "sessionStart hook blocked: Prompt blocked by policy",
    details: { hookRunId: "session-start:0:/home/.codex/hooks.json", eventName: "sessionStart", status: "blocked" },
  }])
  expect(ingest("hook/completed", hookRun("failed", [], "exit status 2")).events).toMatchObject([{
    type: "harness-notice", code: "codex_app_server.hook_failed", severity: "warn", message: "sessionStart hook failed: exit status 2",
  }])
  expect(ingest("hook/completed", hookRun("completed", [{ kind: "warning", text: "hooks.json is deprecated" }])).events).toMatchObject([{
    type: "harness-notice", code: "codex_app_server.hook_completed", severity: "info", message: "sessionStart hook completed: hooks.json is deprecated",
  }])
})

test("thread settings update the served model and record nothing", () => {
  const { events, state } = ingest("thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5.5", effort: "low" } })
  expect(events).toEqual([])
  expect(state.reportedModels).toEqual({ "thread-1": "gpt-5.5" })
})

test("goal notifications belong to the goal owner and are not reported again here", () => {
  const goal = { threadId: "thread-1", objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }
  expect(ingest("thread/goal/updated", { threadId: "thread-1", turnId: null, goal }).events).toEqual([])
  expect(ingest("thread/goal/cleared", { threadId: "thread-1" }).events).toEqual([])
})

test("model verification is bookkeeping, not a notice the person reads", () => {
  expect(ingest("model/verification", { threadId: "thread-1", verified: true }).events).toMatchObject([
    { type: "harness-notice", code: "codex_app_server.model_verification", severity: "debug" },
  ])
})
