import { machine, unreachable, type Machine } from "@/lib/machine"
import type { AppError, DiffScope, GitPushResult, Placement, PromptAttachment } from "@/server"
import { basename } from "@/files"
import type { ReviewKey } from "./i18n"
import { t } from "./i18n"

export const defaultScope: DiffScope = { kind: "uncommitted" }

export function scopeEquals(a: DiffScope, b: DiffScope): boolean {
  if (a.kind === "branch" || a.kind === "branchWorktree") return b.kind === a.kind && b.base === a.base
  if (a.kind === "range") return b.kind === "range" && b.from === a.from && b.to === a.to
  return a.kind === b.kind
}

export type DiffStyle = "unified" | "split"

export type LineSide = "additions" | "deletions"

export type LineComment = {
  readonly id: string
  readonly file: string
  readonly start: number
  readonly end: number
  readonly side: LineSide
  readonly text: string
  readonly preview?: string
}

export type LineCommentInput = Omit<LineComment, "id">

const ERROR_CLASSES = new Set(["auth", "rate_limit", "network", "not_found", "conflict", "invalid", "internal"])

function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false
  const record = value as { readonly class?: unknown; readonly message?: unknown; readonly retryable?: unknown }
  return (
    typeof record.class === "string" &&
    ERROR_CLASSES.has(record.class) &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  )
}

export function asAppError(error: unknown): AppError {
  if (isAppError(error)) return error
  return { class: "internal", message: error instanceof Error ? error.message : String(error), retryable: false, cause: error }
}

const GIT_ERROR_KEYS: Readonly<Record<string, ReviewKey>> = {
  git_empty_message: "review.error.git_empty_message",
  git_nothing_staged: "review.error.git_nothing_staged",
  git_conflict: "review.error.git_conflict",
  git_push_rejected: "review.error.git_push_rejected",
  git_timeout: "review.error.git_timeout",
}

export function errorText(error: AppError): string {
  const key = error.code === undefined ? undefined : GIT_ERROR_KEYS[error.code]
  return key === undefined ? error.message : t(key, { message: error.message })
}

export type Flow<Step extends string, Result> =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly step: Step }
  | { readonly kind: "done"; readonly result: Result }
  | { readonly kind: "failed"; readonly error: AppError }

export type FlowEvent<Step extends string, Result> =
  | { readonly type: "start"; readonly step: Step }
  | { readonly type: "step"; readonly step: Step }
  | { readonly type: "done"; readonly result: Result }
  | { readonly type: "failed"; readonly error: AppError }
  | { readonly type: "reset" }

export function flowTransition<Step extends string, Result>(
  state: Flow<Step, Result>,
  event: FlowEvent<Step, Result>,
): Flow<Step, Result> {
  switch (event.type) {
    case "start":
      return { kind: "running", step: event.step }
    case "step":
      return state.kind === "running" ? { kind: "running", step: event.step } : state
    case "done":
      return state.kind === "running" ? { kind: "done", result: event.result } : state
    case "failed":
      return state.kind === "running" ? { kind: "failed", error: event.error } : state
    case "reset":
      return { kind: "idle" }
    default:
      return unreachable(event)
  }
}

export type FlowMachine<Step extends string, Result> = Machine<Flow<Step, Result>, FlowEvent<Step, Result>>

export function createFlow<Step extends string, Result>(): FlowMachine<Step, Result> {
  return machine<Flow<Step, Result>, FlowEvent<Step, Result>>({ kind: "idle" }, flowTransition)
}

export async function runFlow<Step extends string, Result>(
  flow: FlowMachine<Step, Result>,
  first: Step,
  run: (step: (next: Step) => void) => Promise<Result>,
): Promise<void> {
  flow.send({ type: "start", step: first })
  try {
    const result = await run((next) => flow.send({ type: "step", step: next }))
    flow.send({ type: "done", result })
  } catch (error) {
    flow.send({ type: "failed", error: asAppError(error) })
  }
}

export type CommitFlow = Flow<"staging" | "committing", { readonly hash: string }>
export type PushFlow = Flow<"pushing", GitPushResult>
export type WorktreeFlow = Flow<"creating", Placement>

export function commentRangeLabel(comment: Pick<LineComment, "start" | "end">): string {
  if (comment.start === comment.end) return t("review.comment.line", { line: comment.start })
  return t("review.comment.lines", { start: comment.start, end: comment.end })
}

export function commentLabel(comment: LineComment): string {
  return `${basename(comment.file)}:${comment.start}`
}

export function commentAttachment(comment: LineComment): PromptAttachment {
  const range = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`
  const quoted = comment.preview ? `\n${comment.preview}` : ""
  return { kind: "text", label: commentLabel(comment), text: `${comment.file}:${range}${quoted}\n\n${comment.text}` }
}
