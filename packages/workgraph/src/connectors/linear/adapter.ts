import type { ConnectorInterface, NormalizedIssue } from "../../orchestrator/events"
import type { LinearConnector } from "./linear"

export function createLinearAdapter(connector: LinearConnector): ConnectorInterface {
  return {
    provider: "linear",

    hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue> {
      return connector.hydrateIssue(params.issueId)
    },

    updateIssue(params: Record<string, any>, updates: { title?: string; status?: string; description?: string }): Promise<void> {
      return connector.updateIssue(params.issueId, updates)
    },

    addComment(params: Record<string, any>, comment: string): Promise<void> {
      return connector.addComment(params.issueId, comment)
    },

    createIssue(params: Record<string, any>, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(params.teamId, data)
    },
  }
}
