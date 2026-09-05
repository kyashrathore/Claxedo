export type AgentFileContent = {
  type: "text" | "binary"
  content: string
  diff?: string
  patch?: {
    oldFileName: string
    newFileName: string
    oldHeader?: string
    newHeader?: string
    hunks: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: string[]
    }>
    index?: string
  }
  encoding?: "base64"
  mimeType?: string
}

export type AgentVcsFileDiff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

/** A fully identified diff ready for review presentation. */
export type AgentReviewFileDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type AgentPresentationModel = {
  id: string
  name: string
}

/** Provider fields consumed by transcript presentation. */
export type AgentPresentationProvider = {
  id: string
  name: string
  models: Record<string, AgentPresentationModel>
}

/** Structural guard: is `value` a well-formed review diff record? */
export function isAgentReviewFileDiff(value: unknown): value is AgentReviewFileDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if ("patch" in value && value.patch !== undefined && typeof value.patch !== "string") return false
  if ("before" in value && value.before !== undefined && typeof value.before !== "string") return false
  if ("after" in value && value.after !== undefined && typeof value.after !== "string") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

/** Coerce an unknown payload (array, single diff, or keyed object) into a diff list. */
export function agentReviewFileDiffList(value: unknown): AgentReviewFileDiff[] {
  if (Array.isArray(value) && value.every(isAgentReviewFileDiff)) return value
  if (Array.isArray(value)) return value.filter(isAgentReviewFileDiff)
  if (isAgentReviewFileDiff(value)) return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).filter(isAgentReviewFileDiff)
}
