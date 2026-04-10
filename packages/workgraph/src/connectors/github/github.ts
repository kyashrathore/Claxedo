import type { Octokit } from "@octokit/rest"
import type { NormalizedIssue, ProviderParams, ProviderPreview, ProviderQueryMode } from "../../orchestrator/events/connector"

export class GitHubConnector {
  private octokit: Octokit

  constructor(octokit: Octokit) {
    this.octokit = octokit
  }

  async hydrateIssue(owner: string, repo: string, issueNumber: number): Promise<NormalizedIssue> {
    const response = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    })

    const data = response.data as typeof response.data & {
      sub_issues?: unknown
      subIssues?: unknown
      children?: unknown
      tracked_issues?: unknown
      aggregate_only?: boolean
      parent?: unknown
      parent_issue?: unknown
    }
    const childKeys = refs(data.sub_issues, owner, repo)
      .concat(refs(data.subIssues, owner, repo))
      .concat(refs(data.children, owner, repo))
      .concat(refs(data.tracked_issues, owner, repo))

    return {
      id: data.number.toString(),
      title: data.title,
      description: data.body || "",
      // Map github states to our internal narrow type
      status: data.state === "open" ? "open" : "closed",
      provider_url: data.html_url,
      external_key: key(owner, repo, data.number),
      parent_external_key: ref(data.parent, owner, repo) ?? ref(data.parent_issue, owner, repo),
      child_external_keys: childKeys,
      aggregate_only: typeof data.aggregate_only === "boolean" ? data.aggregate_only : childKeys.length > 0,
    }
  }

  async updateIssue(owner: string, repo: string, issueNumber: number, updates: { title?: string; state?: "open" | "closed"; body?: string }): Promise<void> {
    await this.octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, ...updates })
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
  }

  async createIssue(owner: string, repo: string, data: { title: string; body: string }): Promise<NormalizedIssue> {
    const response = await this.octokit.rest.issues.create({ owner, repo, ...data })
    const d = response.data
    return {
      id: d.number.toString(),
      title: d.title,
      description: d.body || "",
      status: d.state === "open" ? "open" : "closed",
      provider_url: d.html_url,
    }
  }

  async validate(): Promise<{ label?: string }> {
    const response = await this.octokit.rest.users.getAuthenticated()
    return { label: response.data.login }
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
    const scope = githubScope(params)
    if (!scope.length) throw new Error("GitHub queries need repo scope or org scope")
    const terms = ["is:issue", ...scope]
    if (mode === "assigned_to_me") terms.push("assignee:@me")
    if (mode === "updated_since") {
      const since = text(params.updated_since)
      if (!since) throw new Error("GitHub updated_since queries need updated_since")
      terms.push(`updated:>=${since}`)
    }
    const response = await this.octokit.rest.search.issuesAndPullRequests({
      q: terms.join(" "),
      per_page: limit,
      sort: "updated",
      order: "desc",
    })
    const items = response.data.items
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
