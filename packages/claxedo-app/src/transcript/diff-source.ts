import type { AgentReviewFileDiff } from "@claxedo/agent-runtime-contract"

export type DiffSource = Pick<AgentReviewFileDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  source: DiffSource
}

export function normalize(diff: AgentReviewFileDiff): ViewDiff {
  return {
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    source: { file: diff.file, patch: diff.patch, before: diff.before, after: diff.after },
  }
}
