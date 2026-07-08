import { Composio } from "@composio/core"
import type { NormalizedIssue, ProviderParams, ProviderPreview, ProviderQueryMode } from "../interface"

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

export type GitHubProxyRequest = {
  endpoint: string
  method: Method
  body?: unknown
  parameters?: Array<{
    in: "query" | "header"
    name: string
    value: string | number
  }>
}

export type GitHubProxyResponse = {
  data?: unknown
}

export interface GitHubProxyExecutor {
  proxy(request: GitHubProxyRequest): Promise<GitHubProxyResponse>
}

export class ComposioGitHubExecutor implements GitHubProxyExecutor {
  private connectedAccountId: string
  private composio: Composio

  constructor(connectedAccountId: string, composio = createComposioClient()) {
    this.connectedAccountId = connectedAccountId
    this.composio = composio
  }

  async proxy(request: GitHubProxyRequest): Promise<GitHubProxyResponse> {
    return this.composio.tools.proxyExecute({
      ...request,
      connectedAccountId: this.connectedAccountId,
      parameters: [
        { in: "header", name: "Accept", value: "application/vnd.github.v3+json" },
        ...(request.parameters ?? []),
      ],
    })
  }
}

/**
 * Plain-fetch GitHub executor for hosts that bring their own token supply —
 * shaped after @claxedo/connections' CapabilityHandle (`getToken` /
 * `reportAuthFailure`). The token is resolved per request so rotation works;
 * a 401 reports an auth failure upstream before throwing. No Composio needed.
 */
export class FetchGitHubExecutor implements GitHubProxyExecutor {
  private getToken: () => Promise<string>
  private reportAuthFailure?: (reason: string) => Promise<void>

  constructor(options: {
    getToken: () => Promise<string>
    reportAuthFailure?: (reason: string) => Promise<void>
  }) {
    this.getToken = options.getToken
    this.reportAuthFailure = options.reportAuthFailure
  }

  async proxy(request: GitHubProxyRequest): Promise<GitHubProxyResponse> {
    const token = await this.getToken()
    const url = new URL(`https://api.github.com${request.endpoint}`)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    }
    for (const param of request.parameters ?? []) {
      if (param.in === "query") url.searchParams.set(param.name, String(param.value))
      if (param.in === "header") headers[param.name] = String(param.value)
    }
    const init: RequestInit = { method: request.method, headers }
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(request.body)
    }
    const res = await fetch(url, init)
    if (res.status === 401) {
      await this.reportAuthFailure?.(`github 401 on ${request.method} ${request.endpoint}`)
      throw new Error(`GitHub request unauthorized (401): ${request.method} ${request.endpoint}`)
    }
    if (!res.ok) throw new Error(`GitHub request failed (${res.status}): ${request.method} ${request.endpoint}`)
    if (res.status === 204) return {}
    return { data: await res.json() }
  }
}

export class GitHubConnector {
  private executor: GitHubProxyExecutor

  constructor(executor: GitHubProxyExecutor) {
    this.executor = executor
  }

  async hydrateIssue(owner: string, repo: string, issueNumber: number): Promise<NormalizedIssue> {
    const data = issueData(await this.request(`/repos/${segment(owner)}/${segment(repo)}/issues/${issueNumber}`, "GET"))

    const childKeys = refs(data.sub_issues, owner, repo)
      .concat(refs(data.subIssues, owner, repo))
      .concat(refs(data.children, owner, repo))
      .concat(refs(data.tracked_issues, owner, repo))

    return {
      id: String(data.number),
      title: text(data.title) ?? `GitHub issue #${data.number}`,
      description: text(data.body) ?? "",
      status: data.state === "open" ? "open" : "closed",
      provider_url: text(data.html_url) ?? "",
      external_key: key(owner, repo, data.number),
      parent_external_key: ref(data.parent, owner, repo) ?? ref(data.parent_issue, owner, repo),
      child_external_keys: childKeys,
      aggregate_only: typeof data.aggregate_only === "boolean" ? data.aggregate_only : childKeys.length > 0,
    }
  }

  async updateIssue(owner: string, repo: string, issueNumber: number, updates: { title?: string; state?: "open" | "closed"; body?: string }): Promise<void> {
    await this.request(`/repos/${segment(owner)}/${segment(repo)}/issues/${issueNumber}`, "PATCH", updates)
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${segment(owner)}/${segment(repo)}/issues/${issueNumber}/comments`, "POST", { body })
  }

  async createIssue(owner: string, repo: string, data: { title: string; body: string }): Promise<NormalizedIssue> {
    const d = issueData(await this.request(`/repos/${segment(owner)}/${segment(repo)}/issues`, "POST", data))
    return {
      id: String(d.number),
      title: text(d.title) ?? `GitHub issue #${d.number}`,
      description: text(d.body) ?? "",
      status: d.state === "open" ? "open" : "closed",
      provider_url: text(d.html_url) ?? "",
    }
  }

  async validate(): Promise<{ label?: string }> {
    return { label: text(record(await this.request("/user", "GET"))?.login) }
  }

  async queryIssues(mode: ProviderQueryMode, params: ProviderParams): Promise<ProviderPreview[]> {
    if (mode === "single_item") {
      const owner = text(params.owner)
      const repo = text(params.repo)
      const issueNumber = number(params.issueNumber ?? params.issue_number)
      if (!owner || !repo || !issueNumber) throw new Error("GitHub single item queries need owner, repo, and issue number")
      const issue = await this.hydrateIssue(owner, repo, issueNumber)
      return [{
        ...issue,
        provider: "github",
        provider_meta: { owner, repo, issueNumber },
      }]
    }

    const limit = number(params.limit) ?? 20
    const rawQuery = text(params.q)
    const terms: string[] = []
    if (rawQuery) {
      // Raw GitHub search syntax pass-through ("repo:acme/app is:open label:bug").
      terms.push("is:issue", rawQuery)
    } else {
      const scope = githubScope(params)
      if (!scope.length) throw new Error("GitHub queries need repo scope or org scope")
      terms.push("is:issue", ...scope)
      if (mode === "assigned_to_me") terms.push("assignee:@me")
      if (mode === "updated_since") {
        const since = text(params.updated_since)
        if (!since) throw new Error("GitHub updated_since queries need updated_since")
        terms.push(`updated:>=${since}`)
      }
    }
    const response = record(await this.request("/search/issues", "GET", undefined, [
      { in: "query", name: "q", value: terms.join(" ") },
      { in: "query", name: "per_page", value: limit },
      { in: "query", name: "sort", value: "updated" },
      { in: "query", name: "order", value: "desc" },
    ]))
    const items = array(response?.items)
      .filter((item) => !("pull_request" in item && item.pull_request))
      .map((item) => meta(item))
      .filter((item): item is { owner: string; repo: string; issueNumber: number } => !!item)
    const seen = new Set<string>()
    const list = items.filter((item) => {
      const key = `${item.owner}/${item.repo}#${item.issueNumber}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return Promise.all(list.map(async (item) => ({
      ...(await this.hydrateIssue(item.owner, item.repo, item.issueNumber)),
      provider: "github",
      provider_meta: item,
    })))
  }

  private async request(endpoint: string, method: Method, body?: unknown, parameters?: GitHubProxyRequest["parameters"]) {
    const response = await this.executor.proxy({ endpoint, method, body, parameters })
    return response.data
  }
}

function createComposioClient() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim()
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is required for GitHub provider connections")
  const version = process.env.COMPOSIO_GITHUB_TOOLKIT_VERSION?.trim()
  return new Composio(version ? { apiKey, toolkitVersions: { github: version } } : { apiKey })
}

function segment(value: string) {
  return encodeURIComponent(value)
}

function key(owner: string, repo: string, issue: unknown) {
  if (typeof issue !== "number" && typeof issue !== "string") return undefined
  return `${owner}/${repo}#${issue}`
}

function ref(input: unknown, owner: string, repo: string) {
  const row = item(input)
  if (!row) return
  return key(owner, repo, row.number ?? row.issue_number ?? row.id)
}

function refs(input: unknown, owner: string, repo: string) {
  const row = item(input)
  const list = Array.isArray(input) ? input : Array.isArray(row?.nodes) ? row.nodes : []
  return list
    .map((item: unknown) => ref(item, owner, repo))
    .filter((item: string | undefined): item is string => !!item)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function number(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function githubScope(params: ProviderParams) {
  const owner = text(params.owner)
  const repo = text(params.repo)
  const org = text(params.org)
  if (owner && repo) return [`repo:${owner}/${repo}`]
  if (org) return [`org:${org}`]
  if (owner) return [`org:${owner}`]
  return []
}

function meta(input: unknown) {
  const row = item(input)
  const repo = row?.repository_url
  if (typeof repo !== "string") return
  const path = new URL(repo).pathname.split("/").filter(Boolean)
  const owner = path.at(-2)
  const name = path.at(-1)
  const issueNumber = typeof row?.number === "number" ? row.number : undefined
  if (!owner || !name || !issueNumber) return
  return { owner, repo: name, issueNumber }
}

function item(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as {
    id?: string | number
    number?: string | number
    issue_number?: string | number
    repository_url?: string
    nodes?: unknown[]
  }
}

function issueData(value: unknown) {
  const row = record(value)
  if (!row) throw new Error("GitHub response did not include an issue object")
  const number = typeof row.number === "number" ? row.number : undefined
  if (number === undefined) throw new Error("GitHub issue response did not include a numeric issue number")
  return row as {
    number: number
    title?: unknown
    body?: unknown
    state?: unknown
    html_url?: unknown
    sub_issues?: unknown
    subIssues?: unknown
    children?: unknown
    tracked_issues?: unknown
    aggregate_only?: unknown
    parent?: unknown
    parent_issue?: unknown
  }
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}
