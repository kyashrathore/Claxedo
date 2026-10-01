import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("maps the SDK questions array without losing choices or multi-select behavior", () => {
    expect(runtime().ingest({
      source: "claude.sdk.message",
      method: "claude/can-use-tool",
      payload: {
        requestId: "question-1",
        toolName: "AskUserQuestion",
        input: { questions: [{
          question: "Which checks?",
          header: "Checks",
          multiSelect: true,
          options: [
            { label: "Unit", description: "Fast isolated checks" },
            { label: "Browser", description: "Exercise the UI" },
          ],
        }] },
      },
    }).events).toMatchObject([{
      type: "question",
      requestId: "question-1",
      questions: [{
        text: "Which checks?",
        header: "Checks",
        options: ["Unit", "Browser"],
        optionDescriptions: { Unit: "Fast isolated checks", Browser: "Exercise the UI" },
        multiple: true,
        custom: true,
      }],
    }])
  })

  test("maps non-question canUseTool callbacks to permission requests", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      method: "claude/can-use-tool",
      payload: {
        requestId: "perm-1",
        toolName: "Bash",
        input: { command: "bun test", cwd: "/repo", description: "Run tests" },
      },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "perm-1",
      tool: "Bash",
      paths: ["/repo"],
      details: { command: "bun test", reason: "Run tests" },
    }])
  })
})
