import type { AgentFileContent } from "@claxedo/agent-runtime-contract"

export type FileNode = {
  readonly name: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly ignored: boolean
}

export type FileContent = AgentFileContent

export type FileSearchEntries = "files" | "all"

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"

export type FileChange = {
  readonly path: string
  readonly status: ChangeStatus
  readonly additions: number
  readonly deletions: number
  readonly from?: string
}

export type GitStatus = {
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly staged: readonly FileChange[]
  readonly unstaged: readonly FileChange[]
}

export type GitCommit = {
  readonly hash: string
  readonly shortHash: string
  readonly subject: string
  readonly author: string
  readonly date: string
  readonly refs: readonly string[]
  readonly parents: readonly string[]
}

export type GitRefs = {
  readonly branches: readonly string[]
  readonly tags: readonly string[]
  readonly recent: readonly { readonly hash: string; readonly subject: string }[]
}

export type GitBases = { readonly defaultRef?: string; readonly candidates: readonly string[] }

export type DiffScope =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "staged" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "branch"; readonly base: string }
  | { readonly kind: "branchWorktree"; readonly base: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string }

export type DiffStatus = "added" | "deleted" | "modified"

export type DiffSummary = {
  readonly file: string
  readonly status?: DiffStatus
  readonly additions: number
  readonly deletions: number
  readonly from?: string
}

export type DiffFile = DiffSummary & {
  readonly patch?: string
  readonly before?: string
  readonly after?: string
}

export type GitCommitInput = { readonly message: string; readonly amend?: boolean }

export type GitPushInput = { readonly setUpstream?: boolean }

export type GitPushResult = { readonly remote: string; readonly branch: string }

export type WorktreeCreateInput = { readonly name?: string; readonly baseRef?: string }
