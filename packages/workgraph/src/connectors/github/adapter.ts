import type { ConnectorInterface, NormalizedIssue } from "../../orchestrator/events"
import type { GitHubConnector } from "./github"

export function createGitHubAdapter(connector: GitHubConnector): ConnectorInterface {
  return {
    provider: "github",

    hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue> {
      return connector.hydrateIssue(params.owner, params.repo, params.issueNumber)
    },

    updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void> {
      return connector.updateIssue(params.owner, params.repo, params.issueNumber, {
        title: updates.title,
        state: updates.status === "closed" ? "closed" : updates.status === "open" ? "open" : undefined,
        body: updates.description,
      })
    },

    addComment(params: Record<string, any>, comment: string): Promise<void> {
      return connector.addComment(params.owner, params.repo, params.issueNumber, comment)
    },

    createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(params.owner, params.repo, { title: data.title, body: data.description })
    },
  }
}
