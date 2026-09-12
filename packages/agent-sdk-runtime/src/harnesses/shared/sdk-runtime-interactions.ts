import {
  permissionReplied,
  questionRejected,
  questionReplied,
  type CompatEvent,
} from "../../compat-events"
import type { AgentPermission, AgentQuestion } from "../../index"
import type { AgentExecutionBinding, AgentQuestionAnswer } from "@claxedo/agent-runtime-contract"
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
      .filter((row) => this.permissions.has(row.id))
  }

  respondPermission(
    binding: AgentExecutionBinding,
    permissionId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
  ): AgentInteractionResult | void {
    const directory = requireWorkspaceDirectory(binding.directory)
    const row = this.store.listPermissions(directory).find(
      (item) => item.id === permissionId && item.sessionID === binding.sessionId,
    )
    const pending = this.permissions.get(permissionId)
    if (pending && pending.sessionId !== binding.sessionId) {
      throw new Error(`Permission ${permissionId} does not belong to session ${binding.sessionId}`)
    }
    if (pending && !row) {
      throw new Error(`Permission ${permissionId} is not pending in workspace ${directory}`)
    }
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
      .filter((row) => this.questions.has(row.id))
  }

  replyQuestion(binding: AgentExecutionBinding, questionId: string, answers: AgentQuestionAnswer[]): AgentInteractionResult | void {
    const pending = this.ownedQuestion(binding, questionId)
    if (!pending) return
    const committed = this.store.appendEvent({
      sessionId: pending.sessionId,
      agentSessionId: pending.agentSessionId,
      payload: questionReplied(pending.sessionId, questionId, answers),
      source: { dir: "out", method: "question.reply", frame: { answers } },
    })
    this.questions.delete(questionId)
    pending.resolve(answers)
    return { events: [committed.payload] }
  }

  rejectQuestion(binding: AgentExecutionBinding, questionId: string): AgentInteractionResult | void {
    this.ownedQuestion(binding, questionId)
    return this.rejectPendingQuestion(questionId)
  }

  private ownedQuestion(binding: AgentExecutionBinding, questionId: string) {
    const directory = requireWorkspaceDirectory(binding.directory)
    const pending = this.questions.get(questionId)
    if (!pending) return undefined
    if (pending.sessionId !== binding.sessionId) {
      throw new Error(`Question ${questionId} does not belong to session ${binding.sessionId}`)
    }
    const row = this.store.listQuestions(directory).find(
      (item) => item.id === questionId && item.sessionID === binding.sessionId,
    )
    if (!row) throw new Error(`Question ${questionId} is not pending in workspace ${directory}`)
    return pending
  }

  rejectQuestions(sessionId: string) {
    for (const [id, pending] of Array.from(this.questions)) {
      if (pending.sessionId === sessionId) this.rejectPendingQuestion(id)
    }
  }

  private rejectPendingQuestion(questionId: string): AgentInteractionResult | void {
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
    // Snapshot: the loop deletes from the same map it walks.
    const entries = Array.from(this.permissions)
    for (const [id, item] of entries) {
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
