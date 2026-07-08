import type { IntakeActivityKind } from "../../model/types"

export interface NormalizedGitHubWebhook {
  externalId: string
  externalUrl: string | null
  title: string
  bodyMd: string
  repoRef: string | null
  activityKind: IntakeActivityKind
  activityPayload: Record<string, unknown>
  lastKnownState: Record<string, unknown>
}

export function normalizeGitHubWebhook(event: string, payload: unknown): NormalizedGitHubWebhook | null {
  if (!isRecord(payload)) return null
  if (event === "issues") return normalizeIssueEvent(payload)
  if (event === "issue_comment") return normalizeIssueCommentEvent(payload)
  return null
}

function normalizeIssueEvent(payload: Record<string, unknown>): NormalizedGitHubWebhook | null {
  const action = text(payload.action)
  const issue = record(payload.issue)
  const repository = record(payload.repository)
  if (!action || !issue || !repository) return null
  const activityKind = issueActivityKind(action)
  if (!activityKind) return null
  const repo = text(repository.full_name)
  const number = numberValue(issue.number)
  if (!repo || number === null) return null

  return {
    externalId: `${repo}#${number}`,
    externalUrl: text(issue.html_url) ?? null,
    title: text(issue.title) ?? `GitHub issue #${number}`,
    bodyMd: text(issue.body) ?? "",
    repoRef: `github:${repo}`,
    activityKind,
    activityPayload: {
      action,
      number,
      state: text(issue.state) ?? null,
      title: text(issue.title) ?? null,
      url: text(issue.html_url) ?? null,
      repository: repo,
    },
    lastKnownState: {
      action,
      number,
      state: text(issue.state) ?? null,
      title: text(issue.title) ?? null,
      url: text(issue.html_url) ?? null,
      repository: repo,
    },
  }
}

function normalizeIssueCommentEvent(payload: Record<string, unknown>): NormalizedGitHubWebhook | null {
  if (payload.action !== "created") return null
  const issue = record(payload.issue)
  const comment = record(payload.comment)
  const repository = record(payload.repository)
  if (!issue || !comment || !repository) return null
  const repo = text(repository.full_name)
  const number = numberValue(issue.number)
  if (!repo || number === null) return null

  return {
    externalId: `${repo}#${number}`,
    externalUrl: text(comment.html_url) ?? text(issue.html_url) ?? null,
    title: text(issue.title) ?? `GitHub issue #${number}`,
    bodyMd: text(comment.body) ?? "",
    repoRef: `github:${repo}`,
    activityKind: "external_comment",
    activityPayload: {
      action: "created",
      number,
      state: text(issue.state) ?? null,
      title: text(issue.title) ?? null,
      url: text(comment.html_url) ?? text(issue.html_url) ?? null,
      repository: repo,
      commentBody: text(comment.body) ?? "",
    },
    lastKnownState: {
      action: "comment_created",
      number,
      state: text(issue.state) ?? null,
      title: text(issue.title) ?? null,
      url: text(issue.html_url) ?? null,
      repository: repo,
    },
  }
}

function issueActivityKind(action: string): IntakeActivityKind | null {
  if (action === "opened") return "capture"
  if (action === "edited") return "external_edit"
  if (action === "closed" || action === "reopened") return "external_status_change"
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null
}
