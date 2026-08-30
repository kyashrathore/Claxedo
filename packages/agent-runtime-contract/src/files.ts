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
