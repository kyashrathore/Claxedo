import { SourceIssueProviderError, SourceIssueUnauthorizedError, type SourceIssueConnector, type SourceIssueAuthorization } from "../interface"
import { z } from "zod"
import { decodeSourceIssueResponse, providerTimestamp, readSourceIssueResponse, requestSourceIssue } from "../provider-response"

const issueSchema = z.object({
  id: z.string().trim().min(1),
  identifier: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  updatedAt: providerTimestamp,
  state: z.object({ name: z.string().trim().min(1) }),
})
const responseSchema = z.object({
  data: z.object({ issues: z.object({ nodes: z.array(issueSchema) }) }),
  errors: z.array(z.unknown()).optional(),
}).refine((value) => !value.errors?.length)

export function createLinearSourceIssueConnector(input: Readonly<{
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}> = {}): SourceIssueConnector {
  const baseUrl = input.baseUrl ?? "https://api.linear.app/graphql"
  const request = input.fetch ?? globalThis.fetch
  return {
    provider: "linear",
    async list(authorization, query) {
      const response = await call(request, authorization, baseUrl, {
        query: `query Intake($assignee: String!, $team: String) { issues(filter: { assignee: { email: { eq: $assignee } }, team: { key: { eq: $team } } }, first: 100) { nodes { id identifier title description url updatedAt state { name } } } }`,
        variables: { assignee: query.providerUserId, team: query.filters.team || null },
      })
      const data = decodeSourceIssueResponse("linear", responseSchema, await readSourceIssueResponse("linear", response))
      return { issues: data.data.issues.nodes.map((issue) => ({
        externalId: issue.id,
        ...(issue.identifier ? { externalKey: issue.identifier } : {}),
        ...(issue.url ? { externalUrl: issue.url } : {}),
        title: issue.title,
        body: issue.description ?? "",
        status: issue.state.name,
        updatedAt: Date.parse(issue.updatedAt),
        revision: issue.updatedAt,
      })) }
    },
    async comment(authorization, effect) {
      await call(request, authorization, baseUrl, {
        query: `mutation Announce($issue: String!, $body: String!) { commentCreate(input: { issueId: $issue, body: $body }) { success } }`,
        variables: { issue: effect.externalId, body: effect.body },
      }, effect.idempotencyKey)
    },
    async update(authorization, effect) {
      await call(request, authorization, baseUrl, {
        query: `mutation Update($issue: String!, $description: String) { issueUpdate(id: $issue, input: { description: $description }) { success } }`,
        variables: { issue: effect.externalId, description: effect.body ?? null },
      }, effect.idempotencyKey)
    },
  }
}

async function call(fetcher: typeof globalThis.fetch, authorization: SourceIssueAuthorization, url: string, body: unknown, idempotencyKey?: string) {
  const response = await requestSourceIssue("linear", () => fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `${authorization.tokenType === "basic" ? "Basic" : "Bearer"} ${authorization.token}`, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  }))
  if (response.status === 401) throw new SourceIssueUnauthorizedError("linear")
  if (!response.ok) throw new SourceIssueProviderError("linear", response.status)
  return response
}
