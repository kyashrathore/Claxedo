import { parseChannelCommand } from "../core/approval-token"
import type { InboundEnvelope } from "../envelope"
import { createHmac, timingSafeEqual } from "node:crypto"

type GitHubWebhookInput = {
  event: string
  delivery: string
  payload: unknown
  botName?: string
  receivedAt?: number
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function str(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function repo(input: Record<string, unknown>) {
  const repository = record(input.repository)
  const owner = record(repository?.owner)
  const name = str(repository?.name)
  const ownerName = str(owner?.login) ?? str(repository?.owner)
  if (!name || !ownerName) return
  return { owner: ownerName, name }
}

function issueNumber(input: Record<string, unknown>) {
  return num(record(input.issue)?.number) ?? num(record(input.pull_request)?.number)
}

function text(input: {
  event: string
  payload: Record<string, unknown>
}) {
  if (input.event === "issue_comment") return str(record(input.payload.comment)?.body) ?? ""
  if (input.event === "pull_request_review") return str(record(input.payload.review)?.body) ?? ""
  if (input.event === "issues") {
    return [
      str(record(input.payload.issue)?.title),
      str(record(input.payload.issue)?.body),
    ].filter((item): item is string => !!item).join("\n\n")
  }
  return ""
}

function threadPrefix(input: Record<string, unknown>) {
  if (record(input.pull_request) || record(record(input.issue)?.pull_request)) return "pr"
  return "issue"
}

function sender(input: Record<string, unknown>) {
  return str(record(input.sender)?.login)
}

function installation(input: Record<string, unknown>) {
  return String(num(record(input.installation)?.id) ?? str(record(input.repository)?.node_id) ?? "default")
}

function mentions(input: string, botName: string) {
  const token = `@${botName.replace(/^@/, "")}`.toLowerCase()
  return input.toLowerCase().includes(token) ? [token] : []
}

function supportedEvent(input: string) {
  return input === "issue_comment" || input === "pull_request_review" || input === "issues"
}

export function githubWebhookEnvelope(input: GitHubWebhookInput): InboundEnvelope | undefined {
  const payload = record(input.payload)
  if (!payload || !input.delivery.trim() || !supportedEvent(input.event)) return
  const body = text({ event: input.event, payload })
  const botMentions = mentions(body, input.botName ?? "claxedo")
  if (botMentions.length === 0) return
  const repository = repo(payload)
  const number = issueNumber(payload)
  const user = sender(payload)
  if (!repository || !number || !user) return
  return {
    channel: "github",
    externalUserId: user,
    threadKey: `github:${installation(payload)}:${repository.owner}/${repository.name}:${threadPrefix(payload)}-${number}`,
    idempotencyKey: input.delivery,
    text: body,
    receivedAt: input.receivedAt,
    intent: parseChannelCommand(body),
    mentions: botMentions,
    repo: repository,
    raw: input.payload,
  }
}

export function verifyGitHubWebhookSignature(input: {
  body: string | Uint8Array
  secret: string
  signature: string | null | undefined
}) {
  const expected = createHmac("sha256", input.secret).update(input.body).digest()
  const actual = input.signature?.match(/^sha256=([a-f0-9]{64})$/i)?.[1]
  if (!actual) return false
  const received = Buffer.from(actual, "hex")
  return received.length === expected.length && timingSafeEqual(received, expected)
}
