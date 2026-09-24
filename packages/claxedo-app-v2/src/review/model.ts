import type { AppError, DiffScope } from "@/server"
import type { ReviewKey } from "./i18n"

export const defaultScope: DiffScope = { kind: "uncommitted" }

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

export type GitErrorCopy = { readonly key: ReviewKey; readonly params: { readonly message: string } }

export function gitErrorCopy(error: AppError): GitErrorCopy | undefined {
  const key = error.code === undefined ? undefined : GIT_ERROR_KEYS[error.code]
  return key === undefined ? undefined : { key, params: { message: error.message } }
}
