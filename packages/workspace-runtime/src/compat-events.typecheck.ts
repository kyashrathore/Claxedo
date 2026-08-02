import type {
  EventPermissionAsked,
  EventQuestionAsked,
  EventTodoUpdated,
} from "@opencode-ai/sdk/v2"
import {
  messagePartDelta,
  permissionAsked,
  questionAsked,
  todoUpdated,
  type CompatEvent,
} from "./compat-events"

questionAsked({
  id: "q1",
  sessionID: "s1",
  questions: [{
    question: "Ship it?",
    header: "Ship it?",
    options: [{ label: "Yes", description: "Ship it" }],
    custom: false,
  }],
}) satisfies EventQuestionAsked

permissionAsked({
  id: "p1",
  sessionID: "s1",
  permission: "bash",
  patterns: ["/tmp"],
  metadata: {},
  always: ["/tmp"],
}) satisfies EventPermissionAsked

todoUpdated("s1", [{ content: "Ship", status: "pending", priority: "high" }]) satisfies EventTodoUpdated

messagePartDelta({
  sessionID: "s1",
  messageID: "m1",
  partID: "p1",
  field: "text",
  delta: "hi",
}) satisfies Extract<CompatEvent, { type: "message.part.delta" }>

const kinds: Record<CompatEvent["type"], true> = {
  "message.updated": true,
  "message.part.updated": true,
  "message.part.delta": true,
  "message.completed": true,
  "permission.asked": true,
  "permission.replied": true,
  "question.asked": true,
  "question.replied": true,
  "question.rejected": true,
  "todo.updated": true,
  "session.status": true,
  "session.idle": true,
  "session.error": true,
  "session.updated": true,
  "session.diff": true,
  "session.compacted": true,
  "session.agent": true,
  "session.config": true,
  "session.usage": true,
  "runtime.diagnostic": true,
  "server.connected": true,
  "server.heartbeat": true,
}

void kinds

// @ts-expect-error invalid compat event names must not compile
const bad: CompatEvent = { type: "question.created", properties: {} }

void bad

// @ts-expect-error permission.asked requires metadata and always
permissionAsked({
  id: "p2",
  sessionID: "s1",
  permission: "bash",
  patterns: ["/tmp"],
})
