import type { NormalizedIssue, ProviderParams, ProviderPreview, ProviderQueryMode } from "../interface"

interface LinearClient {
  getIssue(issueId: string): Promise<LinearIssue>
  updateIssue(issueId: string, input: ProviderParams): Promise<void>
  createComment(issueId: string, body: string): Promise<void>
  createIssue(teamId: string, input: ProviderParams): Promise<{ id: string; url: string }>
  getViewer?(): Promise<{ email?: string; name?: string; id?: string }>
  listIssues?(input: { mode: ProviderQueryMode; params: ProviderParams }): Promise<Array<{ id: string }>>
}

export class LinearConnector {
  private client: LinearClient

  constructor(client: LinearClient) {
    this.client = client
  }

  async hydrateIssue(issueId: string): Promise<NormalizedIssue> {
    const data = await this.client.getIssue(issueId)
    const childKeys = refs(data.children)
      .concat(refs(data.subIssues))
      .concat(refs(data.issues))
    return {
      id: data.id,
      title: data.title,
      description: data.description || "",
      status: this.mapStatus(data.state?.name || ""),
      provider_url: data.url,
      external_key: data.identifier ?? data.id,
      parent_external_key: ref(data.parent),
      child_external_keys: childKeys,
      aggregate_only: typeof data.aggregate_only === "boolean" ? data.aggregate_only : childKeys.length > 0,
    }
  }

  async updateIssue(issueId: string, updates: { title?: string; status?: string; description?: string }): Promise<void> {
    const input: ProviderParams = {}
    if (updates.title) input.title = updates.title
    if (updates.description) input.description = updates.description
    if (updates.status) input.status = updates.status
    await this.client.updateIssue(issueId, input)
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment(issueId, body)
  }

  async createIssue(teamId: string, data: { title: string; description: string }): Promise<NormalizedIssue> {
    const result = await this.client.createIssue(teamId, { title: data.title, description: data.description })
    return {
      id: result.id,
      title: data.title,
      description: data.description,
      status: "open",
      provider_url: result.url,
    }
  }

  async validate(): Promise<{ label?: string }> {
    if (!this.client.getViewer) return {}
    const data = await this.client.getViewer()
    return { label: data.email ?? data.name ?? data.id }
  }

  async queryIssues(mode: ProviderQueryMode, params: ProviderParams): Promise<ProviderPreview[]> {
    if (mode === "single_item") {
      const issueId = text(params.issueId ?? params.issue_id)
      if (!issueId) throw new Error("Linear single item queries need issue_id")
      const issue = await this.hydrateIssue(issueId)
      return [{
        ...issue,
        provider: "linear",
        provider_meta: { issueId },
      }]
    }
    if (!this.client.listIssues) throw new Error("Linear query preview is not configured")
    const rows = await this.client.listIssues({ mode, params })
    return Promise.all(rows.map(async (row) => ({
      ...(await this.hydrateIssue(row.id)),
      provider: "linear",
      provider_meta: { issueId: row.id },
    })))
  }

  private mapStatus(linearState: string): "open" | "closed" | "in_progress" {
    const lower = linearState.toLowerCase()
    if (lower === "done" || lower === "canceled" || lower === "cancelled") return "closed"
    if (lower === "in progress" || lower === "started") return "in_progress"
    return "open"
  }
}

function ref(input: unknown) {
  const row = item(input)
  if (!row) return
  if (typeof row.identifier === "string") return row.identifier
  if (typeof row.id === "string") return row.id
}

function refs(input: unknown) {
  const row = item(input)
  const list = Array.isArray(input) ? input : Array.isArray(row?.nodes) ? row.nodes : []
  return list
    .map((item: unknown) => ref(item))
    .filter((item: string | undefined): item is string => !!item)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

type LinearRef = {
  id?: string
  identifier?: string
  nodes?: unknown[]
}

type LinearIssue = {
  id: string
  title: string
  description?: string | null
  url: string
  identifier?: string
  state?: {
    name?: string | null
  } | null
  parent?: LinearRef | null
  children?: LinearRef | null
  subIssues?: LinearRef | null
  issues?: LinearRef | null
  aggregate_only?: boolean
}

function item(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as LinearRef
}
