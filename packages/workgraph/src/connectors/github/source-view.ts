import { SourceIssueProviderError, SourceIssueUnauthorizedError, type SourceIssueConnector, type SourceIssueAuthorization } from "../interface"
import { z } from "zod"
import { decodeSourceIssueResponse, providerIdentifier, providerTimestamp, readSourceIssueResponse, requestSourceIssue } from "../provider-response"

const issueSchema = z.object({
  id: providerIdentifier,
  number: providerIdentifier.optional(),
  html_url: z.string().url().nullable().optional(),
  title: z.string().trim().min(1),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  updated_at: providerTimestamp,
  node_id: z.string().trim().min(1).optional(),
})
const responseSchema = z.object({ items: z.array(issueSchema) })

export function createGitHubSourceIssueConnector(input: Readonly<{
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}> = {}): SourceIssueConnector {
  const baseUrl = (input.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const request = input.fetch ?? globalThis.fetch
  return {
    provider: "github",
    async list(authorization, query) {
      const search = [
        "is:issue",
        `assignee:${query.providerUserId}`,
        query.filters.repo ? `repo:${query.filters.repo}` : "",
        query.filters.state ? `is:${query.filters.state}` : "is:open",
        query.filters.labels?.split(",").map((label) => `label:${label.trim()}`).join(" ") ?? "",
      ].filter(Boolean).join(" ")
      const response = await call(request, authorization, `${baseUrl}/search/issues?q=${encodeURIComponent(search)}&per_page=100`)
      return {
        issues: decodeSourceIssueResponse("github", responseSchema, await readSourceIssueResponse("github", response))
          .items.map(normalizeGitHubIssue),
      }
    },
    async comment(authorization, effect) {
      await call(request, authorization, `${baseUrl}/issues/${encodeURIComponent(effect.externalId)}/comments`, {
        method: "POST",
        headers: { "idempotency-key": effect.idempotencyKey },
        body: JSON.stringify({ body: effect.body }),
      })
    },
    async update(authorization, effect) {
      await call(request, authorization, `${baseUrl}/issues/${encodeURIComponent(effect.externalId)}`, {
        method: "PATCH",
        headers: { "idempotency-key": effect.idempotencyKey },
        body: JSON.stringify({ ...(effect.status ? { state: effect.status } : {}), ...(effect.body ? { body: effect.body } : {}) }),
      })
    },
  }
}

async function call(fetcher: typeof globalThis.fetch, authorization: SourceIssueAuthorization, url: string, init: RequestInit = {}) {
  const response = await requestSourceIssue("github", () => fetcher(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      authorization: `${authorization.tokenType === "basic" ? "Basic" : "Bearer"} ${authorization.token}`,
      ...init.headers,
    },
  }))
  if (response.status === 401) throw new SourceIssueUnauthorizedError("github")
  if (!response.ok) throw new SourceIssueProviderError("github", response.status)
  return response
}

function normalizeGitHubIssue(issue: z.infer<typeof issueSchema>) {
  return {
    externalId: String(issue.number ?? issue.id),
    ...(issue.number !== undefined ? { externalKey: `#${issue.number}` } : {}),
    ...(issue.html_url ? { externalUrl: issue.html_url } : {}),
    title: issue.title,
    body: issue.body ?? "",
    status: issue.state,
    updatedAt: Date.parse(issue.updated_at),
    revision: issue.updated_at,
  }
}
