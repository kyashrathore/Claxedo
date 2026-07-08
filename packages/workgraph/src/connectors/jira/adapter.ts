import type { ConnectorInterface, NormalizedIssue } from "../interface"
import type { JiraConnector } from "./jira"

type JiraParams = {
  issueKey?: string
  projectKey?: string
} & Record<string, unknown>

export function createJiraAdapter(connector: JiraConnector): ConnectorInterface<string, JiraParams> {
  return {
    provider: "jira",

    hydrateIssue(params: JiraParams): Promise<NormalizedIssue> {
      return connector.hydrateIssue(reqText(params.issueKey, "issueKey"))
    },

    updateIssue(params: JiraParams, updates): Promise<void> {
      return connector.updateIssue(reqText(params.issueKey, "issueKey"), updates)
    },

    addComment(params: JiraParams, comment: string): Promise<void> {
      return connector.addComment(reqText(params.issueKey, "issueKey"), comment)
    },

    createIssue(params: JiraParams, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(reqText(params.projectKey, "projectKey"), data)
    },
  }
}

function reqText(value: string | undefined, key: string) {
  if (value) return value
  throw new Error(`Jira params require ${key}`)
}
