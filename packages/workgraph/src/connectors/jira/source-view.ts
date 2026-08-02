import { SourceIssueConfigurationError, SourceIssueProviderError, SourceIssueUnauthorizedError, type SourceIssueConnector, type SourceIssueAuthorization } from "../interface"
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
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}> = {}): SourceIssueConnector {
  const baseUrl = input.baseUrl === undefined ? undefined : requireBaseUrl(input.baseUrl)
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

function connectionBaseUrl(authorization: SourceIssueAuthorization, configuredBaseUrl: string | undefined) {
  if (authorization.fields?.site_url !== undefined) return requireBaseUrl(authorization.fields.site_url)
  if (configuredBaseUrl) return configuredBaseUrl
  throw new SourceIssueConfigurationError("jira", "site_url")
}

const ATLASSIAN_HOST_SUFFIX = ".atlassian.net"

/**
 * Accepts only `https://<site>.atlassian.net`, returning its bare origin.
 *
 * This is the same rule `@claxedo/connections` applies when an Atlassian
 * Connection is created (`impls/atlassian.ts` `normalizeSiteUrl`), restated
 * here rather than imported because workgraph does not depend on that package.
 * Keep the two in step: the pair exists because this function is the one that
 * decides where Basic credentials get sent.
 *
 * It previously accepted `http:` and any hostname except a bare
 * `atlassian.net`, which is far weaker than the connect-time check — and since
 * the connect path validated without persisting, this weaker rule was the only
 * one actually gating the request. A stored value that predates the connect-time
 * fix is refused here instead of being used, because `jiraAuthorization` turns
 * it into `Basic base64(email:token)` on the wire: a mistyped or
 * attacker-suggested host would receive live Atlassian credentials.
 *
 * Self-hosted Jira Data Center is out of scope, matching the connections kit.
 */
function requireBaseUrl(value: string) {
  const url = value.trim().replace(/\/$/, "")
  if (!URL.canParse(url)) throw new SourceIssueConfigurationError("jira", "site_url")
  const parsed = new URL(url)
  if (
    parsed.protocol !== "https:" || parsed.port !== "" ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new SourceIssueConfigurationError("jira", "site_url")
  }
  if (!parsed.hostname.endsWith(ATLASSIAN_HOST_SUFFIX)) {
    throw new SourceIssueConfigurationError("jira", "site_url")
  }
  // Exactly one non-empty DNS label before the suffix: rejects a bare
  // `atlassian.net`, and `sub.acme.atlassian.net`.
  const site = parsed.hostname.slice(0, -ATLASSIAN_HOST_SUFFIX.length)
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(site)) {
    throw new SourceIssueConfigurationError("jira", "site_url")
  }
  // The bare origin, so a stored path (`/wiki/home`) cannot corrupt the REST
  // paths this connector appends.
  return parsed.origin
}

function jiraAuthorization(authorization: SourceIssueAuthorization) {
  if (authorization.tokenType !== "basic") return `Bearer ${authorization.token}`
  const email = authorization.fields?.email
  return `Basic ${btoa(email ? `${email}:${authorization.token}` : authorization.token)}`
}
