import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AgentAssistantMessage, AgentToolPart } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"

const message: AgentAssistantMessage = {
  id: "msg-1",
  sessionID: "ses-1",
  role: "assistant",
  time: { created: 1 },
  parentID: "msg-0",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  mode: "default",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

const QUESTIONS = [
  {
    question: "Which environment should I target?",
    header: "Environment",
    options: [{ label: "staging", description: "" }, { label: "production", description: "" }],
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    multiple: true,
    options: [{ label: "Unit", description: "" }, { label: "Browser", description: "" }],
  },
]

function answered(answers: string[][]): AgentToolPart {
  return {
    id: "prt-question",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: "question",
    state: {
      status: "completed",
      input: { questions: QUESTIONS },
      output: "answered",
      title: "Questions",
      metadata: { answers },
      time: { start: 1, end: 2 },
    },
  }
}

function declined(metadata: Record<string, unknown>): AgentToolPart {
  return {
    id: "prt-question",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: "question",
    state: {
      status: "error",
      input: { questions: QUESTIONS },
      error: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      metadata,
      time: { start: 1, end: 2 },
    },
  }
}

function mount(part: AgentToolPart) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        fileUrl={(path) => `http://runtime.test/file/raw?path=${encodeURIComponent(path)}`}
      >
        <Part part={part} message={message} />
      </DataProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

describe("an answered question keeps its own card in the transcript", () => {
  test("renders the card, not a collapsible tool row", () => {
    const view = mount(answered([["staging"], ["Unit", "Browser"]]))

    expect(view.container.querySelector('[data-component="question-card"]')).not.toBeNull()
    expect(view.container.querySelector('[data-component="tool-trigger"]')).toBeNull()
    expect(view.container.querySelector('[data-component="collapsible"]')).toBeNull()
  })

  test("keeps the question, answer and container slots the matrix spec reads", () => {
    const view = mount(answered([["staging"], ["Unit", "Browser"]]))

    expect(view.container.querySelectorAll('[data-component="question-answers"]').length).toBe(1)
    expect([...view.container.querySelectorAll('[data-slot="question-text"]')].map((node) => node.textContent))
      .toEqual(["Which environment should I target?", "Which checks should run?"])
    expect([...view.container.querySelectorAll('[data-slot="answer-text"]')].map((node) => node.textContent))
      .toEqual(["staging", "Unit", "Browser"])
  })

  test("shows a typed answer verbatim and marks it apart from a picked option", () => {
    const view = mount(answered([["the preview box, with --force"], ["Unit"]]))

    const marks = [...view.container.querySelectorAll('[data-slot="answer-text"]')]
    expect(marks.map((node) => [node.textContent, node.getAttribute("data-kind")])).toEqual([
      ["the preview box, with --force", "custom"],
      ["Unit", "option"],
    ])
  })

  test("a question the reader dismissed stays the one-line note, not a card or an error card", () => {
    const view = mount(declined({ question: { declined: true } }))

    expect(view.container.textContent).toContain("Questions dismissed")
    expect(view.container.querySelector('[data-component="question-card"]')).toBeNull()
    expect(view.container.querySelector('[data-kind="tool-error-card"]')).toBeNull()
  })

  test("a question that failed for any other reason keeps the error card", () => {
    const view = mount(declined({}))

    expect(view.container.querySelector('[data-kind="tool-error-card"]')).not.toBeNull()
    expect(view.container.textContent).not.toContain("Questions dismissed")
  })
})
