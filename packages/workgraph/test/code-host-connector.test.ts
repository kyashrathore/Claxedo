import { describe, expect, test, vi } from "vitest"
import { createGitHubCodeHostConnector } from "../src/connectors"

describe("GitHub code-host connector", () => {
  test("opens a draft pull request with a just-in-time credential and idempotency key", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: 42,
      html_url: "https://github.com/acme/repo/pull/42",
      draft: true,
    }, { status: 201 }))
    const connector = createGitHubCodeHostConnector({ fetch: fetcher })

    await expect(connector.openPullRequest({ token: "secret", tokenType: "bearer" }, {
      repository: "acme/repo",
      head: "workgraph/stream-1",
      base: "dev",
      title: "feat: ship",
      draft: true,
      idempotencyKey: "stream-1:pr",
    })).resolves.toEqual({
      pullRequestId: "42",
      url: "https://github.com/acme/repo/pull/42",
      draft: true,
    })
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/repo/pulls", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer secret", "idempotency-key": "stream-1:pr" }),
      body: JSON.stringify({ head: "workgraph/stream-1", base: "dev", title: "feat: ship", draft: true }),
    }))
  })
})
