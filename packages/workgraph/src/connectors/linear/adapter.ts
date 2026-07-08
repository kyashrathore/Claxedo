import type { ConnectorInterface, NormalizedIssue, ProviderPreview, ProviderQueryMode } from "../interface"
import type { LinearConnector } from "./linear"

type LinearParams = {
  issueId?: string
  teamId?: string
} & Record<string, unknown>

export function createLinearAdapter(connector: LinearConnector): ConnectorInterface<string, LinearParams> {
  return {
    provider: "linear",

    validate(): Promise<{ label?: string }> {
      return connector.validate()
    },

    queryIssues(query: string, params: LinearParams): Promise<ProviderPreview[]> {
      return connector.queryIssues(query as ProviderQueryMode, params)
    },

    hydrateIssue(params: LinearParams): Promise<NormalizedIssue> {
      return connector.hydrateIssue(reqText(params.issueId, "issueId"))
    },

    updateIssue(params: LinearParams, updates): Promise<void> {
      return connector.updateIssue(reqText(params.issueId, "issueId"), updates)
    },

    addComment(params: LinearParams, comment: string): Promise<void> {
      return connector.addComment(reqText(params.issueId, "issueId"), comment)
    },

    createIssue(params: LinearParams, data: { title: string; description: string }): Promise<NormalizedIssue> {
      return connector.createIssue(reqText(params.teamId, "teamId"), data)
    },
  }
}

function reqText(value: string | undefined, key: string) {
  if (value) return value
  throw new Error(`Linear params require ${key}`)
}
