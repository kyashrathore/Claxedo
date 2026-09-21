import { describe, expect, test } from "vitest"
import { createHmac } from "node:crypto"
import { githubWebhookEnvelope, verifyGitHubWebhookSignature } from "./github"

describe("githubWebhookEnvelope", () => {
  test("normalizes issue comments with @claxedo gating and delivery id dedup", () => {
    expect(githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "delivery-1",
      receivedAt: 1_000,
      payload: {
        installation: { id: 42 },
        sender: { login: "octo", id: 583231 },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 7 },
        comment: { body: "@claxedo fix this" },
      },
    })).toMatchObject({
      channel: "github",
      externalUserId: "583231",
      threadKey: "github:42:acme/repo:issue-7",
      idempotencyKey: "delivery-1",
      text: "@claxedo fix this",
      mentions: ["@claxedo"],
      repo: { owner: "acme", name: "repo" },
    })
  })

  test("ignores GitHub payloads that do not mention the bot", () => {
    expect(githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "delivery-2",
      payload: {
        sender: { login: "octo", id: 583231 },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 7 },
        comment: { body: "not for the bot" },
      },
    })).toBeUndefined()
  })

  test("normalizes pull request reviews into PR thread keys", () => {
    expect(githubWebhookEnvelope({
      event: "pull_request_review",
      delivery: "delivery-pr-review",
      payload: {
        installation: { id: 42 },
        sender: { login: "reviewer", id: 90210 },
        repository: { name: "repo", owner: { login: "acme" } },
        pull_request: { number: 8 },
        review: { body: "@claxedo check this review feedback" },
      },
    })).toMatchObject({
      channel: "github",
      externalUserId: "90210",
      threadKey: "github:42:acme/repo:pr-8",
      idempotencyKey: "delivery-pr-review",
      text: "@claxedo check this review feedback",
      repo: { owner: "acme", name: "repo" },
    })
  })

  test("normalizes issue events from title and body text", () => {
    expect(githubWebhookEnvelope({
      event: "issues",
      delivery: "delivery-issue-opened",
      payload: {
        installation: { id: 42 },
        sender: { login: "octo", id: 583231 },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: {
          number: 9,
          title: "@claxedo investigate failing deploy",
          body: "details here",
        },
      },
    })).toMatchObject({
      threadKey: "github:42:acme/repo:issue-9",
      idempotencyKey: "delivery-issue-opened",
      text: "@claxedo investigate failing deploy\n\ndetails here",
    })
  })

  test("normalizes PR issue comments into PR thread keys", () => {
    expect(githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "delivery-pr-comment",
      payload: {
        installation: { id: 42 },
        sender: { login: "octo", id: 583231 },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 10, pull_request: {} },
        comment: { body: "@claxedo fix the PR" },
      },
    })).toMatchObject({
      threadKey: "github:42:acme/repo:pr-10",
    })
  })

  test("keys the sender by account id, so a rename stays the same principal", () => {
    // `sender.login` is renameable and GitHub hands a freed handle to the next
    // account that claims it. The id does neither, so it is the only thing an
    // allowlist entry or an account binding can be written against.
    const comment = (sender: { login: string; id: number }) => githubWebhookEnvelope({
      event: "issue_comment",
      delivery: `delivery-${sender.login}-${sender.id}`,
      payload: {
        installation: { id: 42 },
        sender,
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 7 },
        comment: { body: "@claxedo fix this" },
      },
    })

    expect(comment({ login: "octo", id: 583231 })?.externalUserId).toBe("583231")
    expect(comment({ login: "octo-renamed", id: 583231 })?.externalUserId).toBe("583231")
    expect(comment({ login: "octo", id: 999999 })?.externalUserId).toBe("999999")
  })

  test("refuses a payload whose sender carries no account id", () => {
    expect(githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "delivery-no-id",
      payload: {
        installation: { id: 42 },
        sender: { login: "octo" },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 7 },
        comment: { body: "@claxedo fix this" },
      },
    })).toBeUndefined()
  })

  test("ignores unsupported GitHub events", () => {
    expect(githubWebhookEnvelope({
      event: "push",
      delivery: "delivery-push",
      payload: {
        sender: { login: "octo", id: 583231 },
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 7 },
        comment: { body: "@claxedo nope" },
      },
    })).toBeUndefined()
  })

  test("verifies GitHub webhook SHA-256 signatures", () => {
    const body = JSON.stringify({ action: "created" })
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`

    expect(verifyGitHubWebhookSignature({ body, secret: "secret", signature })).toBe(true)
    expect(verifyGitHubWebhookSignature({ body, secret: "wrong", signature })).toBe(false)
    expect(verifyGitHubWebhookSignature({ body, secret: "secret", signature: undefined })).toBe(false)
    expect(verifyGitHubWebhookSignature({ body, secret: "secret", signature: "sha1=abc" })).toBe(false)
    expect(verifyGitHubWebhookSignature({ body, secret: "secret", signature: "sha256=abc" })).toBe(false)
  })
})
