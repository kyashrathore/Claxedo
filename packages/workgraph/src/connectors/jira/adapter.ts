import type { ConnectorInterface, NormalizedIssue } from "../../orchestrator/events"
import type { JiraConnector } from "./jira"

export function createJiraAdapter(connector: JiraConnector): ConnectorInterface {
  return {
    provider: "jira",

    hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue> {
      return connector.hydrateIssue(params.issueKey)
    },

    updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void> {
      return connector.updateIssue(params.issueKey, updates)
    },

    addComment(params: Record<string, any>, comment: string): Promise<void> {
      return connector.addComment(params.issueKey, comment)
    },

    createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(params.projectKey, data)
    },
  }
}
