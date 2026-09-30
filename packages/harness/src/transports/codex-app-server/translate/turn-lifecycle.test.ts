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

const tooManyDenials = {
  message: "Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 3 reviews); interrupting the turn.",
  codexErrorInfo: "tooManyDenials",
  additionalDetails: null,
}

test("a turn Codex interrupted with an error ends failed with that error, not as a stop", () => {
  expect(runtime().ingest({
    source: "codex.app-server",
    method: "turn/completed",
    payload: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "interrupted", error: tooManyDenials } },
  }).events).toMatchObject([
    { type: "session-status", status: "error" },
    { type: "error", error: tooManyDenials.message, errorClass: "unknown" },
  ])
})

test("a turn interrupted without an error is still a stop", () => {
  expect(runtime().ingest({
    source: "codex.app-server",
    method: "turn/completed",
    payload: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "interrupted", error: null } },
  }).events).toMatchObject([{ type: "session-status", status: "idle" }, { type: "cancelled" }])
})

const classes: Array<[unknown, string]> = [
  ["usageLimitExceeded", "usage_limit"],
  ["rateLimitExceeded", "rate_limit"],
  ["serverOverloaded", "model"],
  ["flexUnavailable", "model"],
  ["unauthorized", "credential"],
  ["sandboxError", "workspace"],
  ["threadRollbackFailed", "session"],
  ["contextWindowExceeded", "unknown"],
  ["sessionBudgetExceeded", "unknown"],
  ["cyberPolicy", "unknown"],
  ["misalignmentPolicyViolation", "unknown"],
  ["tooManyDenials", "unknown"],
  ["internalServerError", "unknown"],
  ["badRequest", "unknown"],
  ["other", "unknown"],
  [{ activeTurnNotSteerable: { turnKind: "review" } }, "unknown"],
  [{ httpConnectionFailed: { httpStatusCode: 429 } }, "rate_limit"],
  [{ responseStreamConnectionFailed: { httpStatusCode: 401 } }, "credential"],
  [{ responseStreamDisconnected: { httpStatusCode: 403 } }, "credential"],
  [{ responseTooManyFailedAttempts: { httpStatusCode: 500 } }, "unknown"],
  [{ responseStreamDisconnected: { httpStatusCode: null } }, "unknown"],
]

for (const [info, errorClass] of classes) {
  test(`Codex error ${JSON.stringify(info)} is a ${errorClass} failure`, () => {
    const events = runtime().ingest({
      source: "codex.app-server",
      method: "error",
      payload: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "stream failed", codexErrorInfo: info, additionalDetails: null } },
    }).events
    expect(events).toMatchObject([{ type: "session-status", status: "error" }, { type: "error", errorClass }])
  })
}

test("a generic session error from a new Codex error kind explains itself", () => {
  expect(runtime().ingest({
    source: "codex.app-server",
    method: "turn/completed",
    payload: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "failed", error: { message: "session error", codexErrorInfo: "flexUnavailable", additionalDetails: null } } },
  }).events).toMatchObject([
    { type: "session-status", status: "error" },
    { type: "error", error: "Flex capacity is unavailable. Try another model or service tier.", errorClass: "model" },
  ])
})

test("a reconnect Codex will retry keeps the turn working and records why", () => {
  const events = runtime().ingest({
    source: "codex.app-server",
    method: "error",
    payload: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "Reconnecting... 2/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null } },
  }).events
  expect(events).toMatchObject([{ type: "diagnostic", diagnostic: { code: "codex_app_server.retryable_error", message: "Reconnecting... 2/5" } }])
  expect(events).toHaveLength(1)
})

test("a thread system error is surfaced without ending the turn", () => {
  const events = runtime().ingest({
    source: "codex.app-server", method: "thread/status/changed",
    payload: { threadId: "thread-1", status: { type: "systemError" } },
  }).events
  expect(events).toMatchObject([{ type: "harness-notice", code: "codex_app_server.thread_system_error", severity: "warn" }])
  expect(events.some((event) => event.type === "error" || event.type === "finish" || event.type === "cancelled"
    || (event.type === "session-status" && event.status !== "busy"))).toBe(false)
})

test("a turn's aggregated diff is one file diff per file it touched, never a file named diff", () => {
  const app = "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n"
  const added = "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export {}\n"
  expect(runtime().ingest({
    source: "codex.app-server",
    method: "turn/diff/updated",
    payload: { threadId: "thread-1", turnId: "turn-1", diff: `${app}${added}` },
  }).events).toEqual([
    expect.objectContaining({ type: "file-diff", path: "src/app.ts", newText: app }),
    expect.objectContaining({ type: "file-diff", path: "src/new.ts", newText: added }),
  ])
})
