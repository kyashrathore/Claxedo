/**
 * @deprecated Interim — auth ownership moved to @claxedo/connections
 * (packages/claxedo-connections); workgraph connector factories now accept a
 * capability-handle-shaped token supplier (see `github({ getToken })` in
 * connectors/index.ts). This legacy per-provider token store stays only while
 * the current app UI uses /graph/providers/*; dies in the app-plugin lane.
 */
import { createGitHubAdapter } from "./connectors/github/adapter"
import { ComposioGitHubExecutor, GitHubConnector } from "./connectors/github/github"
import { createLinearAdapter } from "./connectors/linear/adapter"
import { LinearConnector } from "./connectors/linear/linear"
import type { ConnectorInterface, ProviderName, ProviderParams, ProviderQueryMode } from "./connectors/interface"

export type ProviderConnection = {
  connection_id: string
  provider: ProviderName
  name: string
  token: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

export type ProviderFactory = {
  github?: (token: string) => GitHubConnector
  linear?: (token: string) => LinearConnector
}

export type ProviderAuth = {
  source: "shared_auth" | "github_cli" | "connections"
  token: string
  name?: string
}

export type ProviderAuthResolver = (provider: ProviderName) => Promise<ProviderAuth | null>

export function connector(row: ProviderConnection, overrides?: ProviderFactory) {
  if (row.provider === "github") {
    return overrides?.github?.(row.token) ?? new GitHubConnector(new ComposioGitHubExecutor(row.token))
  }
  return overrides?.linear?.(row.token) ?? new LinearConnector(new LinearApi(row.token))
}

export function adapter(row: ProviderConnection, overrides?: ProviderFactory): ConnectorInterface {
  if (row.provider === "github") return createGitHubAdapter(connector(row, overrides) as GitHubConnector)
  return createLinearAdapter(connector(row, overrides) as LinearConnector)
}

export async function validate(row: ProviderConnection, overrides?: ProviderFactory) {
  const next = connector(row, overrides)
  if (!next.validate) return {}
  return next.validate()
}

export async function preview(
  row: ProviderConnection,
  mode: ProviderQueryMode,
  params: ProviderParams,
  overrides?: ProviderFactory,
) {
  const next = connector(row, overrides)
  if (!next.queryIssues) throw new Error(`${row.provider} query preview is not configured`)
  return next.queryIssues(mode, params)
}

class LinearApi {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  async getViewer() {
    const data = await this.request<{
      viewer?: {
        id?: string
        name?: string
        email?: string
      }
    }>(
      `query Viewer { viewer { id name email } }`,
    )
    return data.viewer ?? {}
  }

  async listIssues(input: { mode: ProviderQueryMode; params: ProviderParams }) {
    const first = limit(input.params.limit)
    if (input.mode === "assigned_to_me") {
      const data = await this.request<{
        viewer?: {
          assignedIssues?: {
            nodes?: Array<{ id: string }>
          }
        }
      }>(
        `query Assigned($first: Int!, $filter: IssueFilter) {
          viewer {
            assignedIssues(first: $first, filter: $filter) {
              nodes { id }
            }
          }
        }`,
        {
          first,
          filter: filter(input.mode, input.params),
        },
      )
      return data.viewer?.assignedIssues?.nodes ?? []
    }
    const data = await this.request<{
      issues?: {
        nodes?: Array<{ id: string }>
      }
    }>(
      `query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter) {
          nodes { id }
        }
      }`,
      {
        first,
        filter: filter(input.mode, input.params),
      },
    )
    return data.issues?.nodes ?? []
  }

  async getIssue(issueId: string) {
    const data = await this.request<{
      issue?: LinearIssue
    }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          state { id name type }
          parent { id identifier }
          children(first: 50) { nodes { id identifier } }
          subIssues(first: 50) { nodes { id identifier } }
          issues(first: 50) { nodes { id identifier } }
          team {
            id
            key
            name
            states(first: 50) {
              nodes { id name type }
            }
          }
          project { id name }
        }
      }`,
      { id: issueId },
    )
    if (!data.issue) throw new Error(`Linear issue '${issueId}' not found`)
    return data.issue
  }

  async updateIssue(issueId: string, input: ProviderParams) {
    const next: Record<string, unknown> = {}
    if (typeof input.title === "string" && input.title.trim()) next.title = input.title
    if (typeof input.description === "string") next.description = input.description
    if (typeof input.status === "string") {
      const stateId = await this.state(issueId, input.status)
      if (stateId) next.stateId = stateId
    }
    if (!Object.keys(next).length) return
    await this.request(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input: next },
    )
  }

  async createComment(issueId: string, body: string) {
    await this.request(
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId, body } },
    )
  }

  async createIssue(teamId: string, input: ProviderParams) {
    const data = await this.request<{
      issueCreate?: {
        issue?: {
          id: string
          url: string
        }
      }
    }>(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id url }
        }
      }`,
      {
        input: {
          teamId,
          title: input.title,
          description: input.description,
        },
      },
    )
    const issue = data.issueCreate?.issue
    if (!issue) throw new Error(`Linear issue creation failed for team '${teamId}'`)
    return issue
  }

  private async state(issueId: string, status: string) {
    const issue = await this.getIssue(issueId)
    const list = issue?.team?.states?.nodes ?? []
    const want = pick(status)
    const exact = list.find((state) => typeof state.type === "string" && state.type.toLowerCase() === want)
    if (exact?.id) return exact.id
    const name = list.find((state) => typeof state.name === "string" && label(status).includes(state.name.toLowerCase()))
    return typeof name?.id === "string" ? name.id : undefined
  }

  private async request<T extends Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}) {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    })
    const json = await res.json() as { data?: T; errors?: Array<{ message?: string }> }
    if (res.ok && !json.errors?.length) return json.data ?? ({} as T)
    const msg = json.errors?.map((item) => item.message).filter(Boolean).join("; ") || `Linear request failed: ${res.status}`
    throw new Error(msg)
  }
}

function limit(value: unknown) {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(num) || num < 1) return 20
  return Math.min(50, Math.floor(num))
}

function filter(mode: ProviderQueryMode, params: ProviderParams) {
  const out: Record<string, unknown> = {}
  const teamId = text(params.teamId ?? params.team_id)
  const projectId = text(params.projectId ?? params.project_id)
  const updated = text(params.updated_since)
  if (teamId) out.team = { id: { eq: teamId } }
  if (projectId) out.project = { id: { eq: projectId } }
  if (mode === "updated_since" && updated) out.updatedAt = { gt: updated }
  return Object.keys(out).length ? out : undefined
}

function pick(status: string) {
  if (status === "closed") return "completed"
  if (status === "in_progress") return "started"
  return "unstarted"
}

function label(status: string) {
  if (status === "closed") return ["done", "completed", "closed"]
  if (status === "in_progress") return ["in progress", "started", "active"]
  return ["todo", "backlog", "open"]
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

type LinearNode = {
  id?: string
  identifier?: string
}

type LinearState = {
  id?: string
  name?: string
  type?: string
}

type LinearIssue = {
  id: string
  identifier?: string
  title: string
  description?: string | null
  url: string
  state?: LinearState | null
  parent?: LinearNode | null
  children?: { nodes?: LinearNode[] } | null
  subIssues?: { nodes?: LinearNode[] } | null
  issues?: { nodes?: LinearNode[] } | null
  team?: {
    states?: {
      nodes?: LinearState[]
    }
  } | null
}
