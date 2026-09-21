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

/** One live continuation settles only after its canonical question event is durable. */
export class SessionQuestionInteractions<T extends { sessionId: string }> {
  readonly pending = new Map<string, T>()
  constructor(private readonly commit: (pending: T, event: CompatEvent) => CompatEvent) {}

  settle(id: string, answers: AgentQuestionAnswer[] | undefined, resolve: (pending: T) => void): AgentInteractionResult | undefined {
    const pending = this.pending.get(id)
    if (!pending) return
    const event = this.commit(pending, answers !== undefined
      ? questionReplied(pending.sessionId, id, answers)
      : questionRejected(pending.sessionId, id))
    this.pending.delete(id)
    resolve(pending)
    return { events: [event] }
  }
}

export class SdkRuntimeInteractions {
  readonly permissions = new Map<string, PendingPermission>()
  private readonly questionOwner: SessionQuestionInteractions<PendingQuestion>
  readonly questions: Map<string, PendingQuestion>

  constructor(private readonly store: SdkRuntimeStore) {
    this.questionOwner = new SessionQuestionInteractions((pending, payload) => this.store.appendEvent({
      sessionId: pending.sessionId, agentSessionId: pending.agentSessionId, payload,
      source: payload.type === "question.replied"
        ? { dir: "out", method: "question.reply", frame: { answers: payload.properties.answers } }
        : { dir: "out", method: "question.reject", frame: {} },
    }).payload)
    this.questions = this.questionOwner.pending
  }

  listPermissions(directory: string): AgentPermission[] {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listPermissions(directory)
      .filter((row) => this.permissions.has(row.id))
  }

  respondPermission(
    binding: AgentExecutionBinding,
    permissionId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    optionId?: string,
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
    if (row?.options !== undefined) {
      if (optionId === undefined || !row.options.some((option) => option.id === optionId)) {
        throw new Error(`Permission ${permissionId} requires one of its offered options`)
      }
    } else if (optionId !== undefined) {
      throw new Error(`Permission ${permissionId} does not offer provider options`)
    }
    const events: CompatEvent[] = []
    if (row) {
      const committed = this.store.appendEvent({
        sessionId: row.sessionID,
        agentSessionId: pending?.agentSessionId,
        payload: permissionReplied(
          row.sessionID,
          permissionId,
          optionId !== undefined ? { optionId } : decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: { dir: "out", method: "permission.reply", frame: optionId !== undefined ? { optionId } : { decision } },
      })
      events.push(committed.payload)
    }
    if (!pending) return
    this.permissions.delete(permissionId)
    pending.resolve(decision, optionId)
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
    return this.questionOwner.settle(questionId, answers, (question) => question.resolve(answers))
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
    return this.questionOwner.settle(questionId, undefined, (question) => question.reject())
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
    for (const id of [...this.questions.keys()]) this.rejectPendingQuestion(id)
  }
}
