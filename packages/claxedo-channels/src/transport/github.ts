import { parseChannelCommand } from "../core/channel-command"
import type { InboundEnvelope } from "../envelope"
import { createHmac, timingSafeEqual } from "node:crypto"
import { filled as str } from "../json"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

type GitHubWebhookInput = {
  event: string
  delivery: string
  payload: unknown
  botName?: string
  receivedAt?: number
}

function repo(input: Record<string, unknown>) {
  const repository = asRecord(input.repository)
  const owner = asRecord(repository?.owner)
  const name = str(repository?.name)
  const ownerName = str(owner?.login) ?? str(repository?.owner)
  if (!name || !ownerName) return undefined
  return { owner: ownerName, name }
}

function issueNumber(input: Record<string, unknown>) {
  return asFiniteNumber(asRecord(input.issue)?.number) ?? asFiniteNumber(asRecord(input.pull_request)?.number)
}

function text(input: {
  event: string
  payload: Record<string, unknown>
}) {
  if (input.event === "issue_comment") return str(asRecord(input.payload.comment)?.body) ?? ""
  if (input.event === "pull_request_review") return str(asRecord(input.payload.review)?.body) ?? ""
  if (input.event === "issues") {
    return [
      str(asRecord(input.payload.issue)?.title),
      str(asRecord(input.payload.issue)?.body),
    ].filter((item): item is string => !!item).join("\n\n")
  }
  return ""
}

function threadPrefix(input: Record<string, unknown>) {
  if (asRecord(input.pull_request) || asRecord(asRecord(input.issue)?.pull_request)) return "pr"
  return "issue"
}

/**
 * The sender's numeric GitHub account id, as a string.
 *
 * `sender.login` is a handle its owner can change and GitHub then hands to
 * someone else, so it cannot key an allowlist or an account binding. The id
 * never moves between accounts. `@chat-adapter/github` parses the same field
 * into `Author.userId` (`user.id.toString()`), so an event arriving over the
 * Chat SDK and the same event arriving here name the same principal.
 */
function senderAccountId(input: Record<string, unknown>) {
  const id = asFiniteNumber(asRecord(input.sender)?.id)
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return undefined
  return String(id)
}

function installation(input: Record<string, unknown>) {
  return String(asFiniteNumber(asRecord(input.installation)?.id) ?? str(asRecord(input.repository)?.node_id) ?? "default")
}

function mentions(input: string, botName: string) {
  const token = `@${botName.replace(/^@/, "")}`.toLowerCase()
  return input.toLowerCase().includes(token) ? [token] : []
}

function supportedEvent(input: string) {
  return input === "issue_comment" || input === "pull_request_review" || input === "issues"
}

export function githubWebhookEnvelope(input: GitHubWebhookInput): InboundEnvelope | undefined {
  const payload = asRecord(input.payload)
  if (!payload || !input.delivery.trim() || !supportedEvent(input.event)) return undefined
  const body = text({ event: input.event, payload })
  const botMentions = mentions(body, input.botName ?? "claxedo")
  if (botMentions.length === 0) return undefined
  const repository = repo(payload)
  const number = issueNumber(payload)
  const user = senderAccountId(payload)
  // Every decision past this point — allowlist, pairing, binding, rate limit —
  // is made about a principal, so an unattributed delivery stops here rather
  // than reaching the access gate.
  if (!repository || !number || !user) return undefined
  return {
    channel: "github",
    externalUserId: user,
    threadKey: `github:${installation(payload)}:${repository.owner}/${repository.name}:${threadPrefix(payload)}-${number}`,
    idempotencyKey: input.delivery,
    text: body,
    receivedAt: input.receivedAt,
    // An issue or PR thread is public and multi-party — never a 1:1 DM. It is
    // also always addressed: this envelope only exists because the body
    // mentions the bot (see the mention check above), so mention-gating in a
    // group is satisfied by construction.
    chatType: "group",
    // Mentions are stripped first: this envelope only exists because the body
    // mentions the bot, so every body starts with "@claxedo" and no
    // `^`-anchored command would otherwise ever match.
    intent: parseChannelCommand(body, { mentions: botMentions }),
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
