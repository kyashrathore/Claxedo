import type { Flow } from "@/lib/flow"
import type { AppError, DiffScope, GitPushResult, Placement } from "@/server"
import type { ReviewKey } from "./i18n"

export const defaultScope: DiffScope = { kind: "uncommitted" }

export function scopeEquals(a: DiffScope, b: DiffScope): boolean {
  if (a.kind === "branch" || a.kind === "branchWorktree") return b.kind === a.kind && b.base === a.base
  if (a.kind === "range") return b.kind === "range" && b.from === a.from && b.to === a.to
  return a.kind === b.kind
}

export type DiffStyle = "unified" | "split"

export function readDiffStyle(value: unknown): DiffStyle | undefined {
  return value === "unified" || value === "split" ? value : undefined
}

const GIT_ERROR_KEYS: Readonly<Record<string, ReviewKey>> = {
  git_empty_message: "review.error.git_empty_message",
  git_nothing_staged: "review.error.git_nothing_staged",
  git_conflict: "review.error.git_conflict",
  git_push_rejected: "review.error.git_push_rejected",
  git_timeout: "review.error.git_timeout",
}

export type ErrorCopy = { readonly key: ReviewKey; readonly params: { readonly message: string } }

export function errorCopy(error: AppError): ErrorCopy | undefined {
  const key = error.code === undefined ? undefined : GIT_ERROR_KEYS[error.code]
  return key === undefined ? undefined : { key, params: { message: error.message } }
}

export type CommitFlow = Flow<"staging" | "committing", { readonly hash: string }>
export type PushFlow = Flow<"pushing", GitPushResult>
export type WorktreeFlow = Flow<"creating", Placement>
