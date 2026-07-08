import { describe, expect, test } from "vitest"
import { normalizeGitHubWebhook } from "../../src/connectors/github/webhook-events"

const issue = {
  number: 42,
  title: "Async intake bug",
  body: "The capture box should not open a session.",
  state: "open",
  html_url: "https://github.com/acme/app/issues/42",
}

const repository = {
  full_name: "acme/app",
  html_url: "https://github.com/acme/app",
}

describe("GitHub webhook normalizer", () => {
  test("normalizes opened issues into capture intake payloads", () => {
    expect(normalizeGitHubWebhook("issues", {
      action: "opened",
      issue,
      repository,
    })).toEqual({
      externalId: "acme/app#42",
      externalUrl: "https://github.com/acme/app/issues/42",
      title: "Async intake bug",
      bodyMd: "The capture box should not open a session.",
      repoRef: "github:acme/app",
      activityKind: "capture",
      activityPayload: expect.objectContaining({
        action: "opened",
        number: 42,
        state: "open",
      }),
      lastKnownState: expect.objectContaining({
        action: "opened",
        number: 42,
        repository: "acme/app",
      }),
    })
  })

  test("normalizes issue comments as external comments on the issue", () => {
    expect(normalizeGitHubWebhook("issue_comment", {
      action: "created",
      issue,
      repository,
      comment: {
        body: "I can reproduce this.",
        html_url: "https://github.com/acme/app/issues/42#issuecomment-1",
      },
    })).toEqual(expect.objectContaining({
      externalId: "acme/app#42",
      externalUrl: "https://github.com/acme/app/issues/42#issuecomment-1",
      bodyMd: "I can reproduce this.",
      activityKind: "external_comment",
      activityPayload: expect.objectContaining({
        commentBody: "I can reproduce this.",
      }),
    }))
  })

  test("returns null for unsupported events and actions", () => {
    expect(normalizeGitHubWebhook("pull_request", {})).toBeNull()
    expect(normalizeGitHubWebhook("issues", { action: "labeled", issue, repository })).toBeNull()
  })
})
