import type { DiffScope, GitCommit } from "@/server"

export type ReviewMode = "uncommitted" | "staged" | "unstaged" | "branch" | "branch-worktree" | "to-from"

export type ReviewSelection = { readonly mode: ReviewMode; readonly fromRef: string; readonly toRef: string }

export const EMPTY_TREE_REF = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const FULL_HASH = /^[0-9a-f]{40}$/

export function isBaseReviewMode(mode: ReviewMode): mode is "branch" | "branch-worktree" {
  return mode === "branch" || mode === "branch-worktree"
}

export function shortRef(ref: string): string {
  return FULL_HASH.test(ref) ? ref.slice(0, 7) : ref
}

export function selectionOf(scope: DiffScope): ReviewSelection {
  switch (scope.kind) {
    case "uncommitted":
    case "staged":
    case "unstaged":
      return { mode: scope.kind, fromRef: "", toRef: "" }
    case "branch":
      return { mode: "branch", fromRef: scope.base, toRef: "" }
    case "branchWorktree":
      return { mode: "branch-worktree", fromRef: scope.base, toRef: "" }
    case "range":
      return { mode: "to-from", fromRef: scope.from, toRef: scope.to }
  }
}

export function scopeOf(mode: ReviewMode, fromRef: string, toRef: string): DiffScope {
  switch (mode) {
    case "uncommitted":
    case "staged":
    case "unstaged":
      return { kind: mode }
    case "branch":
      return { kind: "branch", base: fromRef }
    case "branch-worktree":
      return { kind: "branchWorktree", base: fromRef }
    case "to-from":
      return { kind: "range", from: fromRef, to: toRef || "HEAD" }
  }
}

export function commitScope(commit: Pick<GitCommit, "hash" | "parents">): DiffScope {
  return { kind: "range", from: commit.parents[0] ?? EMPTY_TREE_REF, to: commit.hash }
}
