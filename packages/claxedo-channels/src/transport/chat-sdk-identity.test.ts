import { describe, expect, test } from "vitest"
import { createHmac } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createGitHubAdapter } from "@chat-adapter/github"
import { Chat } from "chat"
import { createChatSdkBridge, type ChatSdkBot } from "./chat-sdk-bridge"
import { chatSdkApprovalDecision } from "./chat-sdk-actions"
import { createMemoryStateAdapter } from "./chat-sdk-memory-state"
import { githubWebhookEnvelope } from "./github"
import {
  createChannelAccess,
  createChannelCore,
  createMemoryApprovalBridge,
  createMemoryChannelAccessStore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  type ChannelDenialReason,
  type ChannelRuntime,
  type InboundEnvelope,
} from "../index"
import { stoppedTurn } from "../core/session-stop.fixture"

const WEBHOOK_SECRET = "fixture-webhook-secret"
const PAIRED = { login: "octocat", id: 583231 }
/** The same handle, freed by a rename and claimed by a different account. */
const IMPOSTER = { login: "octocat", id: 999999 }
const RENAMED = { login: "octocat-away", id: 583231 }

type Account = { login: string; id: number }

async function fixture() {
  return JSON.parse(
    await readFile(new URL("../../test/fixtures/github/issue_comment.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>
}

/** The fixture delivery, re-attributed to `account` exactly as GitHub would. */
async function delivery(account: Account) {
  const payload = await fixture()
  const comment = payload.comment as Record<string, unknown>
  return {
    ...payload,
    sender: { ...(payload.sender as Record<string, unknown>), ...account },
    comment: { ...comment, user: { ...(comment.user as Record<string, unknown>), ...account } },
  }
}

function signed(payload: unknown) {
  const body = JSON.stringify(payload)
  return new Request("https://example.test/channels/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": `fixture-${Math.random()}`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
    body,
  })
}

/**
 * Drive one delivery through the INSTALLED `@chat-adapter/github` and the real
 * `chat` runtime, and return the envelope the bridge produced from the SDK's
 * own `Message`/`Thread`. Nothing here is a stand-in for the vendor: the
 * adapter parses the webhook, the Chat instance routes the mention, and the
 * bridge reads `Author.userId` off the object the adapter built.
 *
 * The adapter demands some credential at construction; the token below is
 * never spent, because reading a delivery is pure parsing and nothing in this
 * test posts back. `botUserId` is supplied for the same reason — without it
 * `initialize()` calls GitHub to learn the bot's own id.
 */
async function envelopeFromRealAdapter(account: Account) {
  const seen: InboundEnvelope[] = []
  const chat = new Chat({
    userName: "claxedo",
    adapters: {
      github: createGitHubAdapter({
        webhookSecret: WEBHOOK_SECRET,
        userName: "claxedo",
        token: "ghp_unused_in_this_test",
        botUserId: 1,
      }),
    },
    state: createMemoryStateAdapter(),
  })
  createChatSdkBridge({
    bot: chat as unknown as ChatSdkBot,
    core: {
      async handleInbound(envelope) {
        seen.push(envelope)
      },
      async onApproval() {
        return { ok: true }
      },
    },
  })

  const tasks: Promise<unknown>[] = []
  const response = await chat.webhooks.github(await signed(await delivery(account)), {
    waitUntil: (task) => {
      tasks.push(task)
    },
  })
  expect(response.status).toBe(200)
  await Promise.all(tasks)
  expect(seen).toHaveLength(1)
  return seen[0]
}

function runtime(): ChannelRuntime & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    async createSession() {
      return { sessionId: "ses_1" }
    },
    async *sendMessage(input) {
      sent.push(`${input.externalUserId}:${input.text}`)
      yield { type: "finish", sessionId: input.sessionId }
    },
    async abortSession(input) {
      return stoppedTurn(input.sessionId)
    },
  }
}

/**
 * The real gate, dedup, session resolver and approval bridge, wired as the
 * server wires them, with only the agent runtime and the outbound surface
 * replaced — neither decides who a sender is.
 */
function channelCore() {
  const store = createMemoryChannelAccessStore()
  const approvals = createMemoryApprovalBridge()
  const denials: { externalUserId: string; reason: ChannelDenialReason | "rate_limited" }[] = []
  const rt = runtime()
  const replies: string[] = []
  const core = createChannelCore({
    runtime: rt,
    dedup: createMemoryDedupStore(),
    sessions: createMemorySessionResolver(rt),
    approvals,
    access: createChannelAccess({ dmPolicy: "pairing", groupPolicy: "allowlist", store }),
    onDenial: (envelope, reason) => {
      denials.push({ externalUserId: envelope.externalUserId, reason })
    },
  })
  const deliver = async (envelope: InboundEnvelope) => {
    await core.handleInbound(envelope, {
      reply: (chunk) => {
        if (chunk.kind === "text") replies.push(chunk.text)
      },
    })
  }
  return { approvals, core, deliver, denials, replies, runtime: rt, store }
}

describe("channel identity from the installed adapters", () => {
  test("the SDK author id, not the login, is the sender the bridge reports", async () => {
    const envelope = await envelopeFromRealAdapter(PAIRED)

    expect(envelope).toMatchObject({
      channel: "github",
      externalUserId: String(PAIRED.id),
    })
    // The handle the SDK also carries stays where it belongs: nowhere near the key.
    expect(envelope.externalUserId).not.toBe(PAIRED.login)
  })

  test("both GitHub ingress paths name the same principal for one delivery", async () => {
    // The direct webhook envelope and the Chat SDK bridge are two producers of
    // the same fact. Disagreeing would mean one human holds two identities and
    // an allowlist entry admits them on one path only.
    const bridged = await envelopeFromRealAdapter(PAIRED)
    const direct = githubWebhookEnvelope({
      event: "issue_comment",
      delivery: "fixture-direct",
      payload: await delivery(PAIRED),
    })

    expect(direct?.externalUserId).toBe(bridged.externalUserId)
  })

  test("a rename keeps the sender bound; the freed handle on a new account does not", async () => {
    const paired = await envelopeFromRealAdapter(PAIRED)
    const renamed = await envelopeFromRealAdapter(RENAMED)
    const imposter = await envelopeFromRealAdapter(IMPOSTER)
    const channels = channelCore()
    await channels.store.allow("github", paired.externalUserId, "owner")

    await channels.deliver(renamed)
    await channels.deliver(imposter)

    // Same account, new handle: still the allowlisted principal, still served.
    expect(renamed.externalUserId).toBe(paired.externalUserId)
    expect(channels.runtime.sent).toEqual([`${PAIRED.id}:${renamed.text}`])
    // New account wearing the old handle: a stranger to the gate, and refused
    // without a reply that would confirm the bot to them.
    expect(imposter.externalUserId).toBe(String(IMPOSTER.id))
    expect(channels.denials).toEqual([
      { externalUserId: String(IMPOSTER.id), reason: "group_not_allowlisted" },
    ])
  })

  test("an approval press is answered by account id, so the freed handle cannot answer", async () => {
    const paired = await envelopeFromRealAdapter(PAIRED)
    const channels = channelCore()
    await channels.store.allow("github", paired.externalUserId, "owner")
    await channels.approvals.request({
      callId: "ses_1:perm_1",
      tool: "bash",
      summary: "rm -rf build",
      sessionId: "ses_1",
      threadKey: paired.threadKey,
      token: "a7f3",
      requestee: paired.externalUserId,
    })

    // `ActionEvent.user` is a Chat SDK `Author`: the id the adapter parsed off
    // the account, beside the handle it can rename at will.
    const press = (account: Account) => chatSdkApprovalDecision({
      actionId: "approve_permission",
      user: { userId: String(account.id), userName: account.login, fullName: account.login },
      data: { token: "a7f3", approved: true },
      threadId: paired.threadKey,
    }, { threadKey: paired.threadKey })

    expect(await channels.core.onApproval(press(IMPOSTER)!)).toEqual({
      ok: false,
      message: "This approval is waiting on the person who made the request.",
    })
    expect(await channels.core.onApproval(press(RENAMED)!)).toEqual({ ok: true })
  })
})
