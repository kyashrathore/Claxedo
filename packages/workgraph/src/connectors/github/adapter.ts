import type { ConnectorInterface, NormalizedIssue } from "../../orchestrator/events"
import type { GitHubConnector } from "./github"

type GitHubParams = {
  owner?: string
  repo?: string
  issueNumber?: number
} & Record<string, unknown>

export function createGitHubAdapter(connector: GitHubConnector): ConnectorInterface<string, GitHubParams> {
  return {
    provider: "github",

    hydrateIssue(params: GitHubParams): Promise<NormalizedIssue> {
      return connector.hydrateIssue(reqText(params.owner, "owner"), reqText(params.repo, "repo"), reqNumber(params.issueNumber, "issueNumber"))
    },

    updateIssue(params: GitHubParams, updates): Promise<void> {
      return connector.updateIssue(reqText(params.owner, "owner"), reqText(params.repo, "repo"), reqNumber(params.issueNumber, "issueNumber"), {
        title: updates.title,
        state: updates.status === "closed" ? "closed" : updates.status === "open" ? "open" : undefined,
        body: updates.description,
      })
    },

    addComment(params: GitHubParams, comment: string): Promise<void> {
      return connector.addComment(reqText(params.owner, "owner"), reqText(params.repo, "repo"), reqNumber(params.issueNumber, "issueNumber"), comment)
    },

    createIssue(params: GitHubParams, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(reqText(params.owner, "owner"), reqText(params.repo, "repo"), { title: data.title, body: data.description })
    },
  }
}

function reqText(value: string | undefined, key: string) {
  if (value) return value
  throw new Error(`GitHub params require ${key}`)
}

function reqNumber(value: number | undefined, key: string) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error(`GitHub params require ${key}`)
}
