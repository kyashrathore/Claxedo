import { describe, expect, test } from "vitest"
import {
  SourceIssueConfigurationError,
  SourceIssueProviderError,
  SourceIssueResponseError,
  SourceIssueTransportError,
  SourceIssueUnauthorizedError,
} from "@claxedo/workgraph/connectors"
import {
  HostedConnectionCredentialUnavailableError,
  HostedConnectionReconnectRequiredError,
} from "./hosted-connections"
import { IntakeStateError, SourceViewVersionConflictError } from "@claxedo/workgraph/hosted"
import { IntakeCandidatePageCursorError, createIntakeCandidatePageCursor } from "@claxedo/workgraph/contracts"
import { createWorkGraphIntakeRouter } from "./intake-router"

describe("WorkGraph intake router", () => {
  test("requires a bounded Candidate page and maps owner-bound cursor failures", async () => {
    const requests: unknown[] = []
    const cursor = createIntakeCandidatePageCursor({ organizationId: "org", ownerUserId: "owner", updatedAt: 2, candidateId: "candidate_2" })
    const router = createWorkGraphIntakeRouter({
      sourceViews: {
        list: async () => [],
        create: async () => { throw new Error("unused") },
        update: async () => { throw new Error("unused") },
        delete: async () => { throw new Error("unused") },
      },
      intake: {
        refresh: async () => ({ created: 0, updated: 0, candidates: [] }),
        read: async () => undefined,
        list: async () => { throw new Error("unbounded list must not be called") },
        page: async (_context, input) => {
          requests.push(input)
          if (input.after) throw new IntakeCandidatePageCursorError("owner_mismatch")
          return { candidates: [], hasMore: false }
        },
        stage: async () => { throw new Error("unused") },
        dismiss: async () => { throw new Error("unused") },
        restore: async () => { throw new Error("unused") },
        syncExternal: async () => { throw new Error("unused") },
      },
      resolveContext: async () => ownerContext(),
    })

    const missingLimit = await router.request("http://workgraph.test/intake")
    const invalidLimit = await router.request("http://workgraph.test/intake?limit=101")
    const unexpected = await router.request("http://workgraph.test/intake?limit=10&state=all")
    const page = await router.request("http://workgraph.test/intake?limit=10&sourceViewId=view_1")
    const stale = await router.request(`http://workgraph.test/intake?limit=10&after=${encodeURIComponent(cursor)}`)

    expect([missingLimit.status, invalidLimit.status, unexpected.status, page.status, stale.status]).toEqual([400, 400, 400, 200, 409])
    expect(await page.json()).toEqual({ candidates: [], hasMore: false })
    expect(await stale.json()).toEqual({ error: { code: "cursor_invalid", message: "Candidate page cursor is no longer valid", retryable: false } })
    expect(requests).toEqual([{ limit: 10, sourceViewId: "view_1" }, { limit: 10, after: cursor }])
  })

  test("routes strict versioned Source View and candidate lifecycle requests", async () => {
    const calls: unknown[] = []
    const sourceView = {
      id: "view_1",
      ownerUserId: "owner",
      version: 2,
      teamConnectionId: "connection_1" as never,
      provider: "github" as const,
      providerUserId: "octocat",
      filters: { repo: "claxedo/cloud" },
      target: { environment: { kind: "hosted_workspace" as const, repositoryUrl: "https://github.com/claxedo/cloud.git" }, repository: { remoteUrl: "https://github.com/claxedo/cloud.git", baseRevision: "dev" } },
      syncPolicy: "announce" as const,
      status: "paused" as const,
      createdAt: 1,
      updatedAt: 2,
    }
    const candidate = {
      candidateKind: "session" as const,
      id: "candidate_1",
      ownerUserId: "owner",
      version: 2,
      sessionId: "session_1",
      title: "Investigate",
      body: "Finding",
      state: "dismissed" as const,
      createdAt: 1,
      updatedAt: 2,
    }
    const router = createWorkGraphIntakeRouter({
      sourceViews: {
        list: async () => [],
        create: async () => { throw new Error("unused") },
        update: async (_context, id, input) => (calls.push({ action: "update", id, input }), sourceView),
        delete: async (_context, id, expectedVersion) => (calls.push({ action: "delete", id, expectedVersion }), sourceView),
      },
      intake: {
        refresh: async () => ({ created: 0, updated: 0, candidates: [] }),
        read: async (_context, id) => id === candidate.id ? candidate : undefined,
        list: async () => [],
        page: async () => ({ candidates: [], hasMore: false }),
        stage: async () => { throw new Error("unused") },
        dismiss: async (_context, id, expectedVersion) => (calls.push({ action: "dismiss", id, expectedVersion }), candidate),
        restore: async (_context, id, expectedVersion) => (calls.push({ action: "restore", id, expectedVersion }), { ...candidate, version: 3, state: "unorganized" }),
        syncExternal: async () => { throw new Error("unused") },
      },
      resolveContext: async () => ownerContext(),
    })
    const json = { "content-type": "application/json" }
    const read = await router.request("http://workgraph.test/intake/candidate_1")
    const updated = await router.request("http://workgraph.test/source-views/view_1", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ expectedVersion: 1, providerUserId: "octocat", filters: { repo: "claxedo/cloud" }, target: sourceView.target, syncPolicy: "announce", status: "paused" }),
    })
    const deleted = await router.request("http://workgraph.test/source-views/view_1", {
      method: "DELETE",
      headers: json,
      body: JSON.stringify({ expectedVersion: 2 }),
    })
    const dismissed = await router.request("http://workgraph.test/intake/candidate_1/dismiss", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    const restored = await router.request("http://workgraph.test/intake/candidate_1/restore", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ expectedVersion: 2 }),
    })

    expect([read.status, updated.status, deleted.status, dismissed.status, restored.status]).toEqual([200, 200, 200, 200, 200])
    expect(await read.json()).toMatchObject({ id: "candidate_1", ownerUserId: "owner" })
    expect(await updated.json()).toMatchObject({ id: "view_1", version: 2, status: "paused" })
    expect(await restored.json()).toMatchObject({ id: "candidate_1", version: 3, state: "unorganized" })
    expect(calls).toEqual([
      { action: "update", id: "view_1", input: { expectedVersion: 1, providerUserId: "octocat", filters: { repo: "claxedo/cloud" }, target: sourceView.target, syncPolicy: "announce", status: "paused" } },
      { action: "delete", id: "view_1", expectedVersion: 2 },
      { action: "dismiss", id: "candidate_1", expectedVersion: 1 },
      { action: "restore", id: "candidate_1", expectedVersion: 2 },
    ])
  })

  test("maps lifecycle conflicts to fixed typed responses", async () => {
    const router = createWorkGraphIntakeRouter({
      sourceViews: {
        list: async () => [],
        create: async () => { throw new Error("unused") },
        update: async () => { throw new SourceViewVersionConflictError() },
        delete: async () => { throw new Error("unused") },
      },
      intake: {
        refresh: async () => ({ created: 0, updated: 0, candidates: [] }),
        read: async () => undefined,
        list: async () => [],
        page: async () => ({ candidates: [], hasMore: false }),
        stage: async () => { throw new Error("unused") },
        dismiss: async () => { throw new IntakeStateError("provider-secret") },
        restore: async () => { throw new Error("unused") },
        syncExternal: async () => { throw new Error("unused") },
      },
      resolveContext: async () => ownerContext(),
    })
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1 }) }
    const update = await router.request("http://workgraph.test/source-views/view_1", {
      ...init,
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 1, providerUserId: "octocat", filters: {}, syncPolicy: "announce", status: "active" }),
    })
    const dismiss = await router.request("http://workgraph.test/intake/candidate_1/dismiss", init)

    expect(update.status).toBe(409)
    expect(await update.json()).toEqual({ error: { code: "source_view_version_conflict", message: "Source View version changed", retryable: false } })
    expect(dismiss.status).toBe(409)
    const body = await dismiss.text()
    expect(JSON.parse(body)).toEqual({ error: { code: "intake_candidate_state_conflict", message: "Candidate state does not allow this action", retryable: false } })
    expect(body).not.toContain("secret")
  })

  test("surfaces malformed provider responses as retryable without exposing provider data", async () => {
    const router = failureRouter(new SourceIssueResponseError("github provider-body-secret"))

    const response = await router.request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        code: "source_issue_response_invalid",
        message: "Source issue provider returned an invalid response",
        retryable: true,
      },
    })
  })

  test("surfaces missing provider configuration as a typed non-retryable response", async () => {
    const response = await failureRouter(new SourceIssueConfigurationError("jira provider-secret", "site_url"))
      .request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(409)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "source_issue_configuration_required",
        message: "Source issue provider configuration is required",
        retryable: false,
      },
    })
    expect(body).not.toContain("secret")
    expect(body).not.toContain("site_url")
  })

  test("surfaces provider failures with safe statuses and fixed redacted details", async () => {
    const cases = [
      {
        error: new SourceIssueProviderError("github provider-body-secret", 429),
        status: 429,
        errorBody: {
          code: "source_issue_provider_error",
          message: "Source issue provider request failed",
          retryable: true,
        },
      },
      {
        error: new SourceIssueProviderError("github provider-body-secret", 503),
        status: 503,
        errorBody: {
          code: "source_issue_provider_error",
          message: "Source issue provider request failed",
          retryable: true,
        },
      },
    ]

    for (const value of cases) {
      const response = await failureRouter(value.error).request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })
      const body = await response.text()

      expect(response.status).toBe(value.status)
      expect(JSON.parse(body)).toEqual({ error: value.errorBody })
      expect(body).not.toContain("secret")
    }
  })

  test("surfaces provider transport failures as retryable without exposing thrown details", async () => {
    const response = await failureRouter(new SourceIssueTransportError("github transport-secret"))
      .request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "source_issue_transport_unavailable",
        message: "Source issue provider transport is unavailable",
        retryable: true,
      },
    })
    expect(body).not.toContain("secret")
  })

  test("requires reconnect for degraded Connections without exposing Connection details", async () => {
    const response = await failureRouter(new HostedConnectionReconnectRequiredError("connection-secret"))
      .request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(409)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "hosted_connection_reconnect_required",
        message: "Connection requires reconnect",
        retryable: false,
      },
    })
    expect(body).not.toContain("secret")
  })

  test("surfaces provider authorization and unavailable credentials with fixed redacted details", async () => {
    const cases = [
      {
        error: new SourceIssueUnauthorizedError("provider-secret"),
        status: 401,
        errorBody: {
          code: "source_issue_provider_unauthorized",
          message: "Source issue provider authorization failed",
          retryable: false,
        },
      },
      {
        error: new HostedConnectionCredentialUnavailableError("connection-secret"),
        status: 503,
        errorBody: {
          code: "hosted_connection_credential_unavailable",
          message: "Connection credential is unavailable",
          retryable: true,
        },
      },
    ]

    for (const value of cases) {
      const response = await failureRouter(value.error).request("http://workgraph.test/source-views/view_1/refresh", { method: "POST" })
      const body = await response.text()

      expect(response.status).toBe(value.status)
      expect(JSON.parse(body)).toEqual({ error: value.errorBody })
      expect(body).not.toContain("secret")
    }
  })

  test("uses the same redacted provider failure mapping for external sync", async () => {
    const response = await failureRouter(new SourceIssueProviderError("github provider-body-secret", 429)).request(
      "http://workgraph.test/intake/candidate_1/sync",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "sync_1", summary: "Shipped" }) },
    )
    const body = await response.text()

    expect(response.status).toBe(429)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "source_issue_provider_error",
        message: "Source issue provider request failed",
        retryable: true,
      },
    })
    expect(body).not.toContain("secret")
  })

  test("uses the same reconnect mapping for external sync", async () => {
    const response = await failureRouter(new HostedConnectionReconnectRequiredError("connection-secret")).request(
      "http://workgraph.test/intake/candidate_1/sync",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "sync_1", summary: "Shipped" }) },
    )
    const body = await response.text()

    expect(response.status).toBe(409)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "hosted_connection_reconnect_required",
        message: "Connection requires reconnect",
        retryable: false,
      },
    })
    expect(body).not.toContain("secret")
  })
})

function failureRouter(error: Error) {
  return createWorkGraphIntakeRouter({
    sourceViews: {
      list: async () => [],
      create: async () => { throw new Error("unused") },
      update: async () => { throw new Error("unused") },
      delete: async () => { throw new Error("unused") },
    },
    intake: {
      refresh: async () => { throw error },
      read: async () => undefined,
      list: async () => [],
      page: async () => ({ candidates: [], hasMore: false }),
      stage: async () => { throw new Error("unused") },
      dismiss: async () => { throw new Error("unused") },
      restore: async () => { throw new Error("unused") },
      syncExternal: async () => { throw error },
    },
    resolveContext: async () => ownerContext(),
  })
}

function ownerContext() {
  return {
    ownerUserId: "owner",
    actor: { type: "user", id: "owner" },
    requestId: "request",
    access: { mode: "owner" },
  } as never
}
