/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { AgentAssistantMessage, AgentUserMessage } from "@claxedo/agent-runtime-contract"
import { formatCommentNote, formatImageMarkNote, formatQuoteNote } from "@/lib/comment-note"
import { promptEcho, type PromptAttachment } from "@/server"
import { MessageComment, Timeline } from "./message-timeline.data"

const user = { id: "u1", sessionID: "s1", role: "user", time: { created: 1 } } as AgentUserMessage

function errorText(message: unknown): string | undefined {
  const assistant = {
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    parentID: "u1",
    time: { created: 2, completed: 3 },
    error: { name: "APIError", data: { message } },
  } as unknown as AgentAssistantMessage
  const rows = Timeline.constructMessageRows(user, () => [], () => false, [assistant], false, "idle", true)
  const row = rows.find((candidate) => candidate._tag === "Error")
  return row?._tag === "Error" ? row.text : undefined
}

test("a failed turn whose error message is a structured body shows the body's type and message", () => {
  expect(errorText({ error: { type: "overloaded_error", message: "Overloaded" } })).toBe("overloaded_error: Overloaded")
})

test("a failed turn whose error message is a record without a known field shows the record", () => {
  expect(errorText({ retryAfter: 30 })).toBe('{"retryAfter":30}')
})

test("a failed turn whose error message is text shows the text", () => {
  expect(errorText("Rate limited")).toBe("Rate limited")
})

test("cold final rendering retains child events on earlier continuation replies", () => {
  const replies = ["a1", "a2", "a3"].map((id) => ({ id, sessionID: "s1", role: "assistant", parentID: "u1", time: { created: 2, completed: 3 } }) as AgentAssistantMessage)
  const notice = { id: "peer", sessionID: "s1", messageID: "a2", type: "notice", notice: { kind: "agent-message", sender: "reviewer", message: "Report ready" }, time: { created: 2 } } as const
  expect(Timeline.coldFinalVisibleAssistantMessageIds(replies, (id) => id === "a2" ? [notice] : []))
    .toEqual(new Set(["a3", "a2"]))
})

test("a notice stays on screen when a settled turn folds its work", () => {
  const assistant = { id: "a1", sessionID: "s1", role: "assistant", parentID: "u1", time: { created: 2, completed: 3 } } as unknown as AgentAssistantMessage
  const base = { sessionID: "s1", messageID: "a1" }
  const parts = [
    { ...base, id: "p1", type: "reasoning", text: "thinking", time: { start: 1, end: 2 } },
    { ...base, id: "p2", type: "notice", notice: { kind: "harness", code: "claude_sdk.informational", message: "Hook blocked", severity: "warn" }, time: { created: 2 } },
    { ...base, id: "p3", type: "text", text: "Checking the hook." },
    { ...base, id: "p4", type: "text", text: "Done." },
  ] as never[]
  const hasText = (part: { type: string }) => "text" in part && !!part.text
  const rows = Timeline.constructMessageRows(user, (id) => (id === "a1" ? parts : []), hasText, [assistant], true, "idle", false)
  const shown = rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partId] : []))
  expect(shown).toContain("p2")
  expect(rows.some((row) => row._tag === "TurnFold" && row.folded)).toBe(true)
})

test("a thought between commands is drawn inside their work group, and the group's header counts only the commands", () => {
  const assistant = { id: "a1", sessionID: "s1", role: "assistant", parentID: "u1", time: { created: 2, completed: 3 } } as unknown as AgentAssistantMessage
  const base = { sessionID: "s1", messageID: "a1" }
  const command = (id: string) => ({ ...base, id, type: "tool", tool: "bash", state: { status: "completed", input: { command: id }, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } } })
  const parts = [
    command("b1"),
    { ...base, id: "th", type: "reasoning", text: "check the other job", time: { start: 2, end: 3 } },
    command("b2"),
    { ...base, id: "t1", type: "text", text: "Both jobs failed." },
  ] as never[]
  const hasText = (part: { type: string }) => "text" in part && !!part.text
  const rows = Timeline.constructMessageRows(user, (id) => (id === "a1" ? parts : []), hasText, [assistant], true, "idle", true)
  const work = rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "work" ? [row.group] : []))
  expect(work).toHaveLength(1)
  const members = Timeline.groupMembers(work[0]!.refs, () => assistant, (ref) => parts.find((part: { id: string }) => part.id === ref.partId))
  expect(members.map((member) => member.part.id)).toEqual(["b1", "th", "b2"])
  expect(Timeline.memberTools(members).map((part) => part.id)).toEqual(["b1", "b2"])
})

function sentComments(attachments: PromptAttachment[]) {
  const echo = promptEcho({ clientRequestId: "c1", text: "Look at these", attachments }, { sessionId: "s1", messageId: "u1", created: 1 })
  return echo.parts.flatMap((part) => MessageComment.fromPart(part) ?? [])
}

test("a sent message shows a chip for each line comment, image mark and quoted excerpt it carried", () => {
  const quote = { source: { kind: "file", path: "docs/guide.md" }, quote: "Install it first.\nThen run it.", comment: "Which version?" } as const
  const comments = sentComments([
    { kind: "text", label: "src/a.ts:4", text: formatCommentNote({ path: "src/a.ts", selection: { startLine: 4, startChar: 0, endLine: 4, endChar: 0 }, comment: "Why?" }) },
    { kind: "text", label: "shot.png #1", text: formatImageMarkNote({ filename: "shot.png", number: 1, comment: "This button" }) },
    { kind: "text", label: "docs/guide.md", text: formatQuoteNote(quote) },
    { kind: "text", label: "Mention", text: "Some mentioned context" },
  ])
  expect(comments).toEqual([
    { kind: "file", path: "src/a.ts", comment: "Why?", selection: { startLine: 4, endLine: 4 } },
    { kind: "image-mark", filename: "shot.png", number: 1, comment: "This button" },
    { kind: "quote", ...quote },
  ])
})
