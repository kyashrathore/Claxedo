import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { githubWebhookEnvelope } from "./github"

async function fixture(name: string) {
  return JSON.parse(await readFile(new URL(`../../test/fixtures/github/${name}`, import.meta.url), "utf8")) as unknown
}

describe("github recorded fixture replay", () => {
  test("replays issue_comment fixtures into channel envelopes", async () => {
    expect(githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "fixture-issue-comment",
      payload: await fixture("issue_comment.json"),
    })).toMatchObject({
      channel: "github",
      externalUserId: "octocat",
      threadKey: "github:4242:acme/infra:issue-17",
      idempotencyKey: "fixture-issue-comment",
      text: "@claxedo investigate the deployment failure",
      repo: { owner: "acme", name: "infra" },
    })
  })

  test("replays pull_request_review fixtures into PR channel envelopes", async () => {
    expect(githubWebhookEnvelope({
      event: "pull_request_review",
      delivery: "fixture-pr-review",
      payload: await fixture("pull_request_review.json"),
    })).toMatchObject({
      channel: "github",
      externalUserId: "reviewer",
      threadKey: "github:4242:acme/infra:pr-18",
      idempotencyKey: "fixture-pr-review",
      text: "@claxedo verify this review feedback",
      repo: { owner: "acme", name: "infra" },
    })
  })
})
