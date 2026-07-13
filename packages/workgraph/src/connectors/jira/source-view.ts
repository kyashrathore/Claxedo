import { SourceIssueProviderError, SourceIssueUnauthorizedError, type SourceIssueConnector, type SourceIssueAuthorization } from "../interface"
import { z } from "zod"
import { decodeSourceIssueResponse, providerTimestamp, readSourceIssueResponse, requestSourceIssue } from "../provider-response"

const issueSchema = z.object({
  id: z.string().trim().min(1),
  key: z.string().trim().min(1).nullable().optional(),
  fields: z.object({
    summary: z.string().trim().min(1),
    description: z.unknown().nullable().optional(),
    status: z.object({ name: z.string().trim().min(1) }),
    updated: providerTimestamp,
  }),
})
const responseSchema = z.object({ issues: z.array(issueSchema) })

export function createJiraSourceIssueConnector(input: Readonly<{
  baseUrl: string
  fetch?: typeof globalThis.fetch
}>): SourceIssueConnector {
  const baseUrl = input.baseUrl.replace(/\/$/, "")
  const request = input.fetch ?? globalThis.fetch
  return {
    provider: "jira",
    async list(authorization, query) {
      const requestBaseUrl = connectionBaseUrl(authorization, baseUrl)
      const jql = query.filters.jql || `assignee = "${query.providerUserId.replaceAll('"', '\\"')}" ORDER BY updated DESC`
      const response = await call(request, authorization, `${requestBaseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100`)
      const body = decodeSourceIssueResponse("jira", responseSchema, await readSourceIssueResponse("jira", response))
      return { issues: body.issues.map((issue) => {
        return {
          externalId: issue.id,
          ...(issue.key ? { externalKey: issue.key } : {}),
          ...(issue.key ? { externalUrl: `${requestBaseUrl}/browse/${issue.key}` } : {}),
          title: issue.fields.summary,
          body: typeof issue.fields.description === "string" ? issue.fields.description : "",
          status: issue.fields.status.name,
          updatedAt: Date.parse(issue.fields.updated),
          revision: issue.fields.updated,
        }
      }) }
    },
    async comment(authorization, effect) {
      await call(request, authorization, `${connectionBaseUrl(authorization, baseUrl)}/rest/api/3/issue/${encodeURIComponent(effect.externalId)}/comment`, {
        method: "POST",
        headers: { "idempotency-key": effect.idempotencyKey },
        body: JSON.stringify({ body: effect.body }),
      })
    },
    async update(authorization, effect) {
      await call(request, authorization, `${connectionBaseUrl(authorization, baseUrl)}/rest/api/3/issue/${encodeURIComponent(effect.externalId)}`, {
        method: "PUT",
        headers: { "idempotency-key": effect.idempotencyKey },
        body: JSON.stringify({ fields: { ...(effect.body ? { description: effect.body } : {}) } }),
      })
    },
  }
}

async function call(fetcher: typeof globalThis.fetch, authorization: SourceIssueAuthorization, url: string, init: RequestInit = {}) {
  const response = await requestSourceIssue("jira", () => fetcher(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: jiraAuthorization(authorization),
      ...init.headers,
    },
  }))
  if (response.status === 401) throw new SourceIssueUnauthorizedError("jira")
  if (!response.ok) throw new SourceIssueProviderError("jira", response.status)
  return response
}

function connectionBaseUrl(authorization: SourceIssueAuthorization, configuredBaseUrl: string) {
  return (authorization.fields?.site_url ?? configuredBaseUrl).replace(/\/$/, "")
}

function jiraAuthorization(authorization: SourceIssueAuthorization) {
  if (authorization.tokenType !== "basic") return `Bearer ${authorization.token}`
  const email = authorization.fields?.email
  return `Basic ${btoa(email ? `${email}:${authorization.token}` : authorization.token)}`
}
