import {
  permissionReplied,
  questionRejected,
  questionReplied,
  type CompatEvent,
} from "../../compat-events"
import type { AgentPermission, AgentQuestion } from "../../index"
import type { AgentInteractionResult } from "../../adapter-contract"
import { requireWorkspaceDirectory } from "../../target"
import type { PendingPermission, PendingQuestion, SdkRuntimeStore } from "./sdk-runtime-driver"

export class SdkRuntimeInteractions {
  readonly permissions = new Map<string, PendingPermission>()
  readonly questions = new Map<string, PendingQuestion>()

  constructor(private readonly store: SdkRuntimeStore) {}

  listPermissions(directory: string): AgentPermission[] {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listPermissions(directory)
      .filter((row) => this.permissions.has(row.id)) as AgentPermission[]
  }

  respondPermission(
    permissionId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): AgentInteractionResult | void {
    directory = requireWorkspaceDirectory(directory)
    const row = this.store.listPermissions(directory).find((item) => item.id === permissionId)
    const pending = this.permissions.get(permissionId)
    const events: CompatEvent[] = []
    if (row) {
      const committed = this.store.appendEvent({
        sessionId: row.sessionID,
        agentSessionId: pending?.agentSessionId,
        payload: permissionReplied(
          row.sessionID,
          permissionId,
          decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: { dir: "out", method: "permission.reply", frame: { decision } },
      })
      events.push(committed.payload)
    }
    if (!pending) return
    this.permissions.delete(permissionId)
    pending.resolve(decision)
    return events.length > 0 ? { events } : undefined
  }

  listQuestions(directory: string): AgentQuestion[] {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listQuestions(directory)
      .filter((row) => this.questions.has(row.id)) as AgentQuestion[]
  }

  replyQuestion(questionId: string, answer: string): AgentInteractionResult | void {
    const pending = this.questions.get(questionId)
    if (!pending) return
    const committed = this.store.appendEvent({
      sessionId: pending.sessionId,
      agentSessionId: pending.agentSessionId,
      payload: questionReplied(pending.sessionId, questionId, [[answer]]),
      source: { dir: "out", method: "question.reply", frame: { answer } },
    })
    this.questions.delete(questionId)
    pending.resolve(answer)
    return { events: [committed.payload] }
  }

  rejectQuestion(questionId: string): AgentInteractionResult | void {
    const pending = this.questions.get(questionId)
    if (!pending) return
    const committed = this.store.appendEvent({
      sessionId: pending.sessionId,
      agentSessionId: pending.agentSessionId,
      payload: questionRejected(pending.sessionId, questionId),
      source: { dir: "out", method: "question.reject", frame: {} },
    })
    this.questions.delete(questionId)
    pending.reject()
    return { events: [committed.payload] }
  }

  resolvePermissions(sessionId?: string, decision: "deny" | "reject_always" = "deny") {
    for (const [id, item] of [...this.permissions.entries()]) {
      if (sessionId && item.sessionId !== sessionId) continue
      this.store.appendEvent({
        sessionId: item.sessionId,
        agentSessionId: item.agentSessionId,
        payload: permissionReplied(item.sessionId, id, "reject"),
        source: { dir: "out", method: "permission.abort", frame: { decision } },
      })
      this.permissions.delete(id)
      item.resolve(decision)
    }
  }

  rejectAllQuestions() {
    for (const item of this.questions.values()) item.reject()
    this.questions.clear()
  }
}
