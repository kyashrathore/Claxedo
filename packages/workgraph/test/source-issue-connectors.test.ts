import { describe, expect, it } from "vitest"
import { createGitHubSourceIssueConnector } from "../src/connectors/github/source-view"
import { createLinearSourceIssueConnector } from "../src/connectors/linear/source-view"
import { createJiraSourceIssueConnector } from "../src/connectors/jira/source-view"
import { SourceIssueConfigurationError, SourceIssueProviderError, SourceIssueResponseError, SourceIssueTransportError, type SourceIssueConnector } from "../src/connectors"

const updated = "2026-07-13T00:00:00Z"
const githubIssue = { id: 100, number: 7, title: "GitHub issue", body: null, html_url: null, state: "open", updated_at: updated }
const linearIssue = { id: "lin-1", identifier: null, title: "Linear issue", description: null, url: null, updatedAt: updated, state: { name: "Todo" } }
const jiraIssue = { id: "100", key: null, fields: { summary: "Jira issue", description: null, status: { name: "Open" }, updated } }

const providerCases = [
  {
    provider: "github" as const,
    empty: { items: [] },
    valid: { items: [githubIssue] },
    malformedEnvelope: { total_count: 0 },
    malformedItems: [
      { items: [{ ...githubIssue, id: undefined, number: undefined, credential_echo: "provider-body-secret" }] },
      { items: [{ ...githubIssue, title: undefined }] },
      { items: [{ ...githubIssue, state: undefined }] },
      { items: [{ ...githubIssue, updated_at: "not-a-timestamp" }] },
      { items: [{ ...githubIssue, updated_at: "1" }] },
      { items: [{ ...githubIssue, id: 1.5, number: undefined }] },
      { items: [{ ...githubIssue, id: -1, number: undefined }] },
      { items: [{ ...githubIssue, html_url: "/relative" }] },
    ],
    expected: { externalId: "7", externalKey: "#7", title: "GitHub issue", body: "", status: "open", updatedAt: Date.parse(updated), revision: updated },
  },
  {
    provider: "linear" as const,
    empty: { data: { issues: { nodes: [] } } },
    valid: { data: { issues: { nodes: [linearIssue] } } },
    malformedEnvelope: { data: { issues: {} } },
    malformedItems: [
      { data: { issues: { nodes: [{ ...linearIssue, id: undefined, credential_echo: "provider-body-secret" }] } } },
      { data: { issues: { nodes: [{ ...linearIssue, title: undefined }] } } },
      { data: { issues: { nodes: [{ ...linearIssue, state: undefined }] } } },
      { data: { issues: { nodes: [{ ...linearIssue, updatedAt: "not-a-timestamp" }] } } },
      { data: { issues: { nodes: [{ ...linearIssue, updatedAt: "1" }] } } },
      { data: { issues: { nodes: [{ ...linearIssue, url: "/relative" }] } } },
    ],
    expected: { externalId: "lin-1", title: "Linear issue", body: "", status: "Todo", updatedAt: Date.parse(updated), revision: updated },
  },
  {
    provider: "jira" as const,
    empty: { issues: [] },
    valid: { issues: [jiraIssue] },
    malformedEnvelope: {},
    malformedItems: [
      { issues: [{ ...jiraIssue, id: undefined, credential_echo: "provider-body-secret" }] },
      { issues: [{ ...jiraIssue, fields: { ...jiraIssue.fields, summary: undefined } }] },
      { issues: [{ ...jiraIssue, fields: { ...jiraIssue.fields, status: undefined } }] },
      { issues: [{ ...jiraIssue, fields: { ...jiraIssue.fields, updated: "not-a-timestamp" } }] },
      { issues: [{ ...jiraIssue, fields: { ...jiraIssue.fields, updated: "1" } }] },
    ],
    expected: { externalId: "100", title: "Jira issue", body: "", status: "Open", updatedAt: Date.parse(updated), revision: updated },
  },
]

describe("Connections-authorized source issue connectors", () => {
  it.each(providerCases)("accepts an explicit empty $provider issue collection", async ({ provider, empty }) => {
    await expect(connector(provider, empty).list(authorization(), { providerUserId: "alice", filters: {} }))
      .resolves.toEqual({ issues: [] })
  })

  it.each(providerCases)("rejects a malformed $provider response envelope without leaking secrets", async ({ provider, malformedEnvelope }) => {
    await expectInvalidResponse(connector(provider, malformedEnvelope))
  })

  it.each(providerCases)("rejects invalid $provider JSON without exposing the response body", async ({ provider }) => {
    await expectInvalidResponse(connectorWithRequest(provider, async () => new Response("provider-body-secret", {
      headers: { "content-type": "application/json" },
    })))
  })

  it.each(providerCases)("preserves a typed $provider HTTP status without exposing its body", async ({ provider }) => {
    const error = await connectorWithRequest(provider, async () => new Response("provider-body-secret", { status: 429 }))
      .list(authorization(), { providerUserId: "alice", filters: {} })
      .then(() => undefined, (cause) => cause)

    expect(error).toBeInstanceOf(SourceIssueProviderError)
    expect(error).toMatchObject({ code: "source_issue_provider_error", status: 429, retryable: true })
    expect(String(error)).not.toContain("provider-body-secret")
    expect(String(error)).not.toContain("credential-live-secret")
  })

  it("rejects an invalid provider status instead of substituting an error result", () => {
    expect(() => new SourceIssueProviderError("github", 700)).toThrow("Source issue provider status must be an HTTP failure status")
  })

  it.each(providerCases)("reports a rejected $provider transport as retryable unavailability without exposing its cause", async ({ provider }) => {
    const error = await connectorWithRequest(provider, async () => { throw new Error("transport-url-token-secret") })
      .list(authorization(), { providerUserId: "alice", filters: {} })
      .then(() => undefined, (cause) => cause)

    expect(error).toBeInstanceOf(SourceIssueTransportError)
    expect(error).toMatchObject({ code: "source_issue_transport_unavailable", retryable: true })
    expect(String(error)).not.toContain("transport-url-token-secret")
    expect(String(error)).not.toContain("credential-live-secret")
  })

  it.each(providerCases)("strictly validates required $provider issue fields", async ({ provider, malformedItems }) => {
    for (const payload of malformedItems) await expectInvalidResponse(connector(provider, payload))
  })

  it.each(providerCases)("normalizes a valid $provider issue without inventing nullable optionals", async ({ provider, valid, expected }) => {
    const result = await connector(provider, valid).list(authorization(), { providerUserId: "alice", filters: {} })
    expect(result.issues).toEqual([expected])
  })

  it("normalizes Linear issues and forwards an idempotency key without retaining authorization", async () => {
    const requests: Array<{ authorization?: string; idempotency?: string; body?: string }> = []
    const connector = createLinearSourceIssueConnector({
      fetch: (async (_url, init) => {
        const headers = new Headers(init?.headers)
        requests.push({ authorization: headers.get("authorization") ?? undefined, idempotency: headers.get("idempotency-key") ?? undefined, body: String(init?.body) })
        const query = JSON.parse(String(init?.body)) as { query: string }
        return Response.json(query.query.startsWith("query") ? {
          data: { issues: { nodes: [{ id: "lin-1", identifier: "ENG-1", title: "Linear issue", description: "body", url: "https://linear.test/ENG-1", updatedAt: "2026-07-13T00:00:00Z", state: { name: "Todo" } }] } },
        } : { data: { commentCreate: { success: true } } })
      }) as typeof fetch,
    })
    const authorization = { token: "linear-live", tokenType: "bearer" as const }
    expect((await connector.list(authorization, { providerUserId: "alice@example.test", filters: { team: "ENG" } })).issues[0]).toMatchObject({ externalId: "lin-1", externalKey: "ENG-1", status: "Todo" })
    await connector.comment(authorization, { externalId: "lin-1", body: "tracking", idempotencyKey: "sync-linear" })
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer linear-live", "Bearer linear-live"])
    expect(requests[1]!.idempotency).toBe("sync-linear")
    expect(JSON.stringify(connector)).not.toContain("linear-live")
  })

  it("uses Jira connection fields only inside the call to build site URL and Basic authorization", async () => {
    const requests: Array<{ url: string; authorization?: string }> = []
    const connector = createJiraSourceIssueConnector({
      baseUrl: "https://configured.example.test",
      fetch: (async (url, init) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? undefined })
        return Response.json({ issues: [{ id: "100", key: "ENG-2", fields: { summary: "Jira issue", description: "body", status: { name: "Open" }, updated: "2026-07-13T00:00:00Z" } }] })
      }) as typeof fetch,
    })
    const authorization = { token: "jira-live", tokenType: "basic" as const, fields: { email: "alice@example.test", site_url: "https://acme.atlassian.net" } }
    expect((await connector.list(authorization, { providerUserId: "alice", filters: {} })).issues[0]).toMatchObject({ externalKey: "ENG-2", externalUrl: "https://acme.atlassian.net/browse/ENG-2" })
    expect(requests[0]!.url).toContain("https://acme.atlassian.net/rest/api/3/search")
    expect(requests[0]!.authorization).toBe(`Basic ${btoa("alice@example.test:jira-live")}`)
    expect(JSON.stringify(connector)).not.toContain("jira-live")
  })

  it("requires an exact Jira site URL before making a provider request", async () => {
    let requests = 0
    const connector = createJiraSourceIssueConnector({
      fetch: (async () => {
        requests++
        return Response.json({ issues: [] })
      }) as typeof fetch,
    })

    const error = await connector.list(authorization(), { providerUserId: "alice", filters: {} })
      .then(() => undefined, (cause) => cause)

    expect(error).toBeInstanceOf(SourceIssueConfigurationError)
    expect(error).toMatchObject({ code: "source_issue_configuration_required", field: "site_url", retryable: false })
    expect(requests).toBe(0)
  })

  it("rejects a generic Jira cloud host before making a provider request", async () => {
    let requests = 0
    const connector = createJiraSourceIssueConnector({
      fetch: (async () => {
        requests++
        return Response.json({ issues: [] })
      }) as typeof fetch,
    })

    await expect(connector.list({
      ...authorization(),
      fields: { site_url: "https://atlassian.net" },
    }, { providerUserId: "alice", filters: {} })).rejects.toBeInstanceOf(SourceIssueConfigurationError)
    expect(requests).toBe(0)
  })

  it("rejects an explicit invalid Jira Connection URL even when the connector is configured", async () => {
    let requests = 0
    const connector = createJiraSourceIssueConnector({
      baseUrl: "https://configured.example.test",
      fetch: (async () => {
        requests++
        return Response.json({ issues: [] })
      }) as typeof fetch,
    })

    await expect(connector.list({
      ...authorization(),
      fields: { site_url: "not-a-url" },
    }, { providerUserId: "alice", filters: {} })).rejects.toBeInstanceOf(SourceIssueConfigurationError)
    expect(requests).toBe(0)
  })
})

function connector(provider: (typeof providerCases)[number]["provider"], payload: unknown): SourceIssueConnector {
  return connectorWithRequest(provider, async () => Response.json(payload))
}

function connectorWithRequest(provider: (typeof providerCases)[number]["provider"], request: () => Promise<Response>): SourceIssueConnector {
  const fetcher = request as typeof fetch
  if (provider === "github") return createGitHubSourceIssueConnector({ fetch: fetcher })
  if (provider === "linear") return createLinearSourceIssueConnector({ fetch: fetcher })
  return createJiraSourceIssueConnector({ baseUrl: "https://acme.atlassian.net", fetch: fetcher })
}

function authorization() {
  return { token: "credential-live-secret", tokenType: "bearer" as const }
}

async function expectInvalidResponse(value: SourceIssueConnector) {
  const error = await value.list(authorization(), { providerUserId: "alice", filters: {} }).then(
    () => undefined,
    (cause) => cause,
  )
  expect(error).toBeInstanceOf(SourceIssueResponseError)
  expect(error).toMatchObject({ retryable: true })
  expect(String(error)).not.toContain("credential-live-secret")
  expect(String(error)).not.toContain("provider-body-secret")
}
