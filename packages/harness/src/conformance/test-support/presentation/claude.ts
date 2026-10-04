import { describe, expect, test } from "bun:test"
import { TOOL_ATTACHMENT_INLINE_MAX_BYTES } from "../../../translate/tool-attachments"
import { claudeSubagentObservations } from "../../../transports/claude-sdk/translate/subagent-observations"
import { createClaudeTaskLedger } from "../../../transports/claude-sdk/translate/task-ledger"
import { claudeRuntime as runtime } from "../../../transports/claude-sdk/test-support/runtime"
import type { CreatePresentationProjection } from "./projection"

export function registerClaudePresentationCases(createClientPresentationProjection: CreatePresentationProjection) {
  describe("claudeSdkAdapter", () => {
    for (const failed of [false, true]) {
    test(`task notification cannot consume the authoritative Bash ${failed ? "error" : "output"}`, () => {
      const agent = runtime()
      const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
      const ingest = (payload: unknown) => agent.ingest({ source: "claude.sdk.message", payload }).events.flatMap((event) => projection.ingest(event))
      ingest({ type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "node work.cjs" } }] } })
      const notification = { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "bash-1", status: failed ? "failed" : "completed", summary: "Run work.cjs", uuid: "done-1" }
      const ledger = createClaudeTaskLedger()
      claudeSubagentObservations({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "bash-1", task_type: "local_bash", description: "Run work.cjs", uuid: "start-1" }, ledger)
      expect(claudeSubagentObservations(notification, ledger)).toEqual([])
      ingest(notification)
      const result = ingest({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "actual tool result", is_error: failed }] }, tool_use_result: { stdout: failed ? "" : "actual tool result", stderr: failed ? "actual tool result" : "" } })
      expect(result.at(-1)).toMatchObject({ payload: {
        type: "message.part.updated", properties: { part: { state: failed ? { status: "error", error: "actual tool result" } : { status: "completed", output: "actual tool result" } } },
      } })
    })

    }

    function assistantTextSession() {
      const agent = runtime()
      const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
      const textByPart = new Map<string, string>()
      const diagnosticCodes: string[] = []
      const ingest = (payload: unknown) => {
        const events = agent.ingest({ source: "claude.sdk.message", payload }).events
        for (const event of events) if (event.type === "diagnostic") diagnosticCodes.push(event.diagnostic.code)
        for (const envelope of events.flatMap((event) => projection.ingest(event))) {
          const row = envelope.payload
          if (row.type === "message.part.updated" && row.properties.part.type === "text") {
            textByPart.set(row.properties.part.id, row.properties.part.text)
          }
          if (row.type === "message.part.delta" && textByPart.has(row.properties.partID)) {
            textByPart.set(row.properties.partID, `${textByPart.get(row.properties.partID) ?? ""}${row.properties.delta}`)
          }
        }
        return events
      }
      return { ingest, diagnosticCodes, assistantText: () => [...textByPart.values()].join("") }
    }

    function textDelta(text: string) {
      return { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }
    }

    function messageStart(id: string) {
      return { type: "stream_event", event: { type: "message_start", message: { id, content: [] } } }
    }

    test("reconciles a turn's second assistant message against its own streamed text", () => {
      const session = assistantTextSession()

      session.ingest(messageStart("message-a"))
      session.ingest(textDelta("Hello"))
      expect(session.ingest({
        type: "assistant",
        uuid: "assistant-a",
        message: { id: "message-a", content: [{ type: "text", text: "Hello" }] },
      })).toEqual([])

      session.ingest(messageStart("message-b"))
      session.ingest(textDelta("Wor"))
      expect(session.ingest({
        type: "assistant",
        uuid: "assistant-b",
        message: { id: "message-b", content: [{ type: "text", text: "World" }] },
      })).toMatchObject([{ type: "text-delta", delta: "ld" }])

      expect(session.assistantText()).toBe("HelloWorld")
      expect(session.diagnosticCodes).toEqual([])
    })

    test("emits a child message's text once when its snapshot arrives twice", () => {
      const session = assistantTextSession()
      const childMessage = {
        type: "assistant",
        uuid: "assistant-child",
        parent_tool_use_id: "tool-agent-parent-1",
        message: { id: "message-child", content: [{ type: "text", text: "Child reply" }] },
      }

      expect(session.ingest(childMessage)).toMatchObject([{ type: "response-start", responseId: "message-child" }, { type: "text-delta", delta: "Child reply" }])
      expect(session.ingest(childMessage)).toEqual([])

      expect(session.assistantText()).toBe("Child reply")
    })

    test("a snapshot diverging from the streamed text emits only its unseen suffix", () => {
      const session = assistantTextSession()

      session.ingest(messageStart("message-1"))
      session.ingest(textDelta("Hello wrold"))
      expect(session.ingest({
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hello world" }] },
      })).toMatchObject([
        { type: "diagnostic", diagnostic: { code: "claude_sdk.assistant_snapshot_divergence", severity: "warn" } },
        { type: "text-delta", delta: "orld" },
      ])

      expect(session.assistantText()).toBe("Hello wroldorld")
    })

    function readImageSession(input: { cwd?: string; filePath: string; data: string | string[] }) {
      const agent = runtime()
      const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
      const ingest = (payload: unknown) => {
        const events = agent.ingest({ source: "claude.sdk.message", payload }).events
        return { events, envelopes: events.flatMap((event) => projection.ingest(event)) }
      }
      if (input.cwd) ingest({ type: "system", subtype: "init", cwd: input.cwd, uuid: "init-1" })
      ingest({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool-read-image-1", name: "Read", input: { file_path: input.filePath } }] },
      })
      const { events, envelopes } = ingest({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-read-image-1",
            content: [
              ...(Array.isArray(input.data) ? input.data : [input.data]).map((data) => (
                { type: "image", source: { type: "base64", media_type: "image/png", data } }
              )),
              { type: "text", text: "This image may contain text." },
              { type: "text", text: "Read 1 image." },
            ],
          }],
        },
      })
      const part = envelopes.map((envelope) => envelope.payload).find(
        (payload): payload is Extract<typeof payload, { type: "message.part.updated" }> => payload.type === "message.part.updated",
      )?.properties.part
      return { events, part }
    }

    test("canonicalises Claude's tool names so the grouping vocabularies match", () => {
      const agent = runtime()
      const projection = createClientPresentationProjection({
        sessionId: "session-1",
        directory: "/repo",
        assistantMessageId: "reply-1",
      })
      const parts = [
        { id: "c1", name: "Bash", input: { command: "bun test" } },
        { id: "c2", name: "Read", input: { file_path: "/repo/a.ts" } },
        { id: "c3", name: "Grep", input: { pattern: "x" } },
      ].flatMap(({ id, name, input }) =>
        agent
          .ingest({
            source: "claude.sdk.message",
            payload: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
          })
          .events.flatMap((event) => projection.ingest(event)),
      )
        .map((envelope) => envelope.payload)
        .filter((payload): payload is Extract<typeof payload, { type: "message.part.updated" }> =>
          payload.type === "message.part.updated",
        )
        .map((payload) => payload.properties.part)
        .filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")

      expect([...new Set(parts.map((part) => part.tool))].sort()).toEqual(["bash", "grep", "read"])
    })

    const ENVIRONMENT_QUESTION = "Which test environment?"
    const CHECKS_QUESTION = "Which checks should run?"

    function askUserQuestionSession(result: Record<string, unknown>) {
      const agent = runtime()
      const projection = createClientPresentationProjection({
        sessionId: "session-1",
        directory: "/repo",
        assistantMessageId: "reply-1",
      })
      const ingest = (payload: unknown) =>
        agent.ingest({ source: "claude.sdk.message", payload }).events.flatMap((event) => projection.ingest(event))
      ingest({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "ask-1",
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: ENVIRONMENT_QUESTION, options: [{ label: "Staging" }, { label: "Production" }] },
                {
                  question: CHECKS_QUESTION,
                  multiSelect: true,
                  options: [{ label: "Unit" }, { label: "Browser" }, { label: "Staging" }],
                },
              ],
            },
          }],
        },
      })
      const envelopes = ingest({ type: "user", message: { role: "user", content: [result.content] }, tool_use_result: result.toolUseResult })
      return envelopes
        .map((envelope) => envelope.payload)
        .filter((payload): payload is Extract<typeof payload, { type: "message.part.updated" }> =>
          payload.type === "message.part.updated",
        )
        .map((payload) => payload.properties.part)
        .filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")
        .at(-1)
    }

    function questionMetadata(part: ReturnType<typeof askUserQuestionSession>) {
      if (part?.type !== "tool" || part.state.status === "pending") return undefined
      return part.state.metadata
    }

    test("carries an answered AskUserQuestion to the question renderer as reconstructed answers", () => {
      const part = askUserQuestionSession({
        content: { type: "tool_result", tool_use_id: "ask-1", content: "Staging; Unit, Browser" },
        toolUseResult: {
          questions: [{ question: ENVIRONMENT_QUESTION }, { question: CHECKS_QUESTION }],
          answers: { [ENVIRONMENT_QUESTION]: "Staging", [CHECKS_QUESTION]: "Unit, Browser" },
        },
      })

      expect(part).toMatchObject({ type: "tool", tool: "question", state: { status: "completed" } })
      expect(questionMetadata(part)?.answers).toEqual([["Staging"], ["Unit", "Browser"]])
    })

    test("leaves a declined AskUserQuestion an error with no answers", () => {
      const part = askUserQuestionSession({
        content: {
          type: "tool_result",
          tool_use_id: "ask-1",
          content: "User dismissed the question",
          is_error: true,
        },
        toolUseResult: undefined,
      })

      expect(part).toMatchObject({ type: "tool", tool: "question", state: { status: "error", error: "User dismissed the question" } })
      expect(questionMetadata(part)).toMatchObject({ claude: { itemType: "dynamic_tool_call" }, question: { declined: true } })
      expect(questionMetadata(part)).not.toHaveProperty("answers")
    })

    test("records the CLI's own rejection of the question as a decline too", () => {
      const part = askUserQuestionSession({
        content: {
          type: "tool_result",
          tool_use_id: "ask-1",
          content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          is_error: true,
        },
        toolUseResult: undefined,
      })

      expect(questionMetadata(part)).toMatchObject({ question: { declined: true } })
    })

    test("leaves an AskUserQuestion that actually failed undeclined", () => {
      const part = askUserQuestionSession({
        content: {
          type: "tool_result",
          tool_use_id: "ask-1",
          content: "Claude AskUserQuestion requires a non-empty questions array",
          is_error: true,
        },
        toolUseResult: undefined,
      })

      expect(part).toMatchObject({ state: { status: "error" } })
      expect(questionMetadata(part)).not.toHaveProperty("question")
    })

    test("a rejected Bash call is not a declined question", () => {
      const agent = runtime()
      const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
      const ingest = (payload: unknown) =>
        agent.ingest({ source: "claude.sdk.message", payload }).events.flatMap((event) => projection.ingest(event))
      ingest({ type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "rm -rf build" } }] } })
      const envelopes = ingest({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "The user doesn't want to proceed with this tool use.", is_error: true }] },
      })

      const part = envelopes
        .map((envelope) => envelope.payload)
        .filter((payload): payload is Extract<typeof payload, { type: "message.part.updated" }> => payload.type === "message.part.updated")
        .map((payload) => payload.properties.part)
        .filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")
        .at(-1)

      expect(part).toMatchObject({ tool: "bash", state: { status: "error" } })
      expect(part?.state.status === "error" ? part.state.metadata : undefined).not.toHaveProperty("question")
    })

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

    test("preserves image bytes inside the session cwd alongside unchanged text output", () => {
      const { events, part } = readImageSession({ cwd: "/repo", filePath: "/repo/docs/screenshot.png", data: png })

      expect(events).toMatchObject([{
        type: "tool-output",
        toolCallId: "tool-read-image-1",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{
          kind: "inline",
          mime: "image/png",
          url: `data:image/png;base64,${png}`,
          filename: "screenshot.png",
        }],
      }])
      expect(events[0]).not.toHaveProperty("attachments.0.path")

      expect(part).toMatchObject({
        type: "tool",


        tool: "read",
        state: {
          status: "completed",
          output: "This image may contain text.\nRead 1 image.",
          attachments: [{
            type: "file",
            sessionID: "session-1",
            messageID: "reply-1",
            mime: "image/png",
            filename: "screenshot.png",
            url: `data:image/png;base64,${png}`,
          }],
        },
      })
    })

    test("gives every image of a multi-image result its own identity instead of the one path the input named", () => {
      const second = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      const { events, part } = readImageSession({ cwd: "/repo", filePath: "/repo/docs/screenshot.png", data: [png, second] })

      expect(events).toMatchObject([{
        type: "tool-output",
        attachments: [
          { kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}` },
          { kind: "inline", mime: "image/png", url: `data:image/png;base64,${second}` },
        ],
      }])
      expect(events[0]).not.toHaveProperty("attachments.0.filename")
      expect(events[0]).not.toHaveProperty("attachments.1.filename")

      const attachments = part?.type === "tool" && part.state.status === "completed" ? part.state.attachments ?? [] : []
      expect(attachments.map((attachment) => attachment.url)).toEqual([
        `data:image/png;base64,${png}`,
        `data:image/png;base64,${second}`,
      ])
      expect(attachments.every((attachment) => !("location" in attachment))).toBe(true)
    })

    test("carries a small read outside the session cwd by value", () => {
      const { events, part } = readImageSession({ cwd: "/repo", filePath: "/tmp/screenshot.png", data: png })

      expect(events).toMatchObject([{
        type: "tool-output",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{ kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}`, filename: "screenshot.png" }],
      }])
      expect(part).toMatchObject({
        state: {
          status: "completed",
          output: "This image may contain text.\nRead 1 image.",
          attachments: [{ type: "file", mime: "image/png", filename: "screenshot.png", url: `data:image/png;base64,${png}` }],
        },
      })
      const attachment = part?.type === "tool" && part.state.status === "completed" ? part.state.attachments?.[0] : undefined
      expect(attachment).not.toHaveProperty("location")
    })

    test("drops an oversized read outside the session cwd but keeps the image's own size and text output", () => {
      const oversized = "A".repeat(TOOL_ATTACHMENT_INLINE_MAX_BYTES + 1)
      const { events, part } = readImageSession({ cwd: "/repo", filePath: "/tmp/huge.png", data: oversized })

      expect(events).toMatchObject([{
        type: "tool-output",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{
          kind: "unretained",
          mime: "image/png",
          filename: "huge.png",
          sourcePath: "/tmp/huge.png",
          bytes: 98_304,
        }],
      }])
      expect(part).toMatchObject({
        state: {
          status: "completed",
          output: "This image may contain text.\nRead 1 image.",
          attachments: [{
            type: "file",
            mime: "image/png",
            filename: "huge.png",
            url: "file:///tmp/huge.png",
            location: { kind: "unretained", bytes: 98_304 },
          }],
        },
      })
    })
  })
}
