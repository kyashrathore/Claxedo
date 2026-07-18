# `@claxedo/channels`

Channel ingress, reply rendering, approval prompts, and transport adapters for
running Claxedo sessions from chat-shaped systems such as GitHub, Telegram,
Slack, Discord, WhatsApp, and local fake transports.

## Install

```sh
npm install @claxedo/channels
```

All provider adapters (`@chat-adapter/github`, `@chat-adapter/slack`,
`@chat-adapter/telegram`, `@chat-adapter/discord`, `@chat-adapter/whatsapp`)
and the personal-mode WhatsApp client (`@whiskeysockets/baileys`) are installed
as regular dependencies, but none of them are loaded when you import the
package root. Provider modules are dynamically imported only when you enable
the corresponding channel (via `createChatSdkBot` registrations or the Baileys
WhatsApp transport), so unused providers add install weight but no runtime
cost.

This package is framework glue. It does not authenticate every provider
webhook by itself. The caller or mounted bot/transport must verify provider
signatures, webhook secret tokens, bot scopes, and account authorization before
calling the shared channel core.

## Public Surface

| Export | Purpose |
| --- | --- |
| `InboundEnvelope`, `OutboundChunk`, `ApprovalRequest`, `ApprovalDecision`, `Attachment`, `ChannelId` | Shared channel event contracts. |
| `createChannelCore`, `ChannelCore` | Core inbound command handling, session resolution, runtime message forwarding, approval handling, and replies. |
| `createMemoryDedupStore`, `DedupStore` | In-memory idempotency/replay guard for demos, tests, and single-process deployments. |
| `createMemorySessionResolver`, `SessionResolver`, `ChannelRuntime`, `SessionRef` | Maps channel threads to Claxedo sessions. |
| `createMemoryApprovalBridge`, `ApprovalBridge` | Pending approval prompt storage and token resolution. |
| `sanitizeChannelText`, `ChannelTextMinimizationOptions` | Redacts common token patterns and truncates long channel output. |
| `streamRuntimeReplies` | Converts runtime event streams into channel reply chunks. |
| `approvalToken`, `parseApprovalReplyText`, `parseChannelCommand` | Text-command helpers for approvals and cancellation. |
| `createChannelsIngress`, `ChannelWebhookBot`, `ChannelWebhookHandler` | Hono ingress mounting for configured channel webhooks. |
| `createChannelRegistry`, `ChannelRegistration`, `ChannelTransportKind` | Environment-driven channel registration. |
| `createChatSdkBot`, `createChatSdkChannelBot` | Chat SDK bot wiring. |
| `chatSdkApprovalDecision` | Chat SDK action payload to approval decision conversion. |
| `channelRetryDelayMs`, `RetryAfterMs` | Retry/backpressure helper. |
| `createChatSdkBridge`, `chatSdkEnvelope`, `ChatSdkBot`, `ChatSdkBridgeThread`, `ChatSdkMessage` | Chat SDK bridge helpers. |
| `createChatSdkRenderer`, `ChatSdkMessageHandle`, `ChatSdkThread` | Chat SDK reply rendering. |
| `githubWebhookEnvelope`, `verifyGitHubWebhookSignature` | GitHub webhook normalization and signature helper. |
| `telegramUpdateEnvelope` | Telegram update normalization. |
| `createBaileysWhatsAppSocket`, `createWhatsAppBaileysTransport` and related types | WhatsApp personal-mode socket and transport glue. |
| `createChannelAccess`, `ChannelAccess`, `ChannelAccessDecision`, `ChannelDenialReason` | DM/group access gate: pairing, allowlists, and identity-blocked handling. |
| `createMemoryChannelAccessStore`, `ChannelAccessStore` | In-memory allow-list + pending-pairing storage for demos and tests. |
| `createMemoryChannelIdentityBindingStore`, `ChannelIdentityBindingStore`, `ChannelIdentityBinding` | Channel sender → Claxedo account binding storage. |
| `generatePairingCode`, `parseDmPolicy`, `parseGroupPolicy`, `seedAllows` | Pairing code generation and access-policy config parsing helpers. |
| `PAIRING_CODE_TTL_MS`, `PAIRING_MAX_PENDING_PER_CHANNEL`, `PAIRING_RESEND_INTERVAL_MS` | Pairing gate tuning constants. |
| `ChannelDmPolicy`, `ChannelGroupPolicy`, `PairingRequest` | Access policy and pairing-request types. |
| `createSlidingWindowRateLimiter`, `rateLimitKey`, `RateLimiter`, `RateLimitDecision`, `RateLimitOptions` | Per-sender sliding-window inbound rate limiting. |

See [`docs/architecture.md`](./docs/architecture.md) for how these fit into the
`InboundEnvelope` pipeline end to end.

## Trust Model

`createChannelsIngress` mounts routes and delegates enabled provider routes to a
caller-provided bot or transport. For Chat SDK-backed providers, the Chat SDK
adapter is responsible for provider webhook verification. For custom handlers,
verify provider signatures before creating an `InboundEnvelope`.

The shared `ChannelCore` can call a caller-provided `authorize` hook before
deduplication and session creation. Use that hook to bind provider identities to
workspace permissions, bot installation state, org membership, and least
privilege channel policy.

Approval tokens identify pending prompts in a channel thread. They are not a
standalone authorization proof. The approval bridge binds prompts to
`threadKey` when present and removes tokens after a decision. Deployments that
need expiry, nonce persistence across processes, or cross-channel approval
policy should provide a durable `ApprovalBridge`.

The memory stores are single-process helpers. Use durable storage for
multi-instance deployments.

## Access Gate & Pairing

`createChannelCore` accepts an optional `access: ChannelAccess`. When set, it
runs FIRST inside `handleInbound` — before dedup, session resolution, or any
runtime/LLM call — so a refused sender never reaches a session and costs at
most one throttled reply. Every envelope routed through a trusted local
injection path (the loopback fake transport) can set `trustedSource: true` to
bypass the gate; never set that flag from a real external webhook.

Build the gate with `createChannelAccess`, giving it a DM policy, an optional
group policy, and a persistence port:

```ts
import {
  createChannelAccess,
  createChannelCore,
  createMemoryChannelAccessStore,
  createMemoryChannelIdentityBindingStore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  parseDmPolicy,
  parseGroupPolicy,
  seedAllows,
  type ChannelRuntime,
} from "@claxedo/channels"

declare const runtime: ChannelRuntime // your session/prompt runtime binding

const access = createChannelAccess({
  dmPolicy: parseDmPolicy(process.env.CLAXEDO_CHANNEL_DM_POLICY), // "pairing" | "allowlist" | "open" | "disabled"
  groupPolicy: parseGroupPolicy(process.env.CLAXEDO_CHANNEL_GROUP_POLICY), // "allowlist" | "open" | "disabled"
  store: createMemoryChannelAccessStore(), // swap for durable storage in multi-instance deployments
  bindings: createMemoryChannelIdentityBindingStore(),
  // Config-seeded always-allowed senders: "telegram:12345", "telegram:*", or "*".
  allowFrom: (process.env.CLAXEDO_CHANNEL_ALLOW_FROM ?? "").split(",").filter(Boolean),
})

const core = createChannelCore({
  runtime,
  dedup: createMemoryDedupStore(),
  sessions: createMemorySessionResolver(runtime),
  access,
  onDenial: (envelope, reason) => {
    // Blocked messages emit a structured reason for an owner-side audit; they
    // never auto-reply to the stranger (a reply is an amplifier). Log this.
    console.warn("channel denial", { channel: envelope.channel, reason })
  },
  canAdminister: (envelope) => seedAllows(process.env.CLAXEDO_CHANNEL_ADMINS?.split(","), envelope.channel, envelope.externalUserId),
})
```

The default `dmPolicy` under `parseDmPolicy` is `"pairing"`: an unpaired DM
sender gets a one-time pairing reply (via `generatePairingCode`) with a code an
owner approves from an authorized chat with `/pairing approve <code>`, handled
in-chat by `ChannelCore` when `canAdminister` allows it. Pairing state — TTL
(`PAIRING_CODE_TTL_MS`, 1h), resend throttle (`PAIRING_RESEND_INTERVAL_MS`,
1h), and the per-channel pending cap (`PAIRING_MAX_PENDING_PER_CHANNEL`, 3) —
bounds what an unauthenticated stranger can cost the bot to at most one
throttled reply and one bounded pending row. Group chats use `groupPolicy`
instead (no pairing flow); `open` and `disabled` skip pairing on both surfaces.
Access is fail-closed: an unrecognized policy value, an errored store, or an
`identity_blocked` binding all deny.

## Rate Limiting

`createChannelCore` also accepts an optional `rateLimiter: RateLimiter`,
checked immediately after the access gate and before any command routing,
dedup, or session work — so an *allowed*-but-abusive sender still can't drive
unbounded turns. Build one with `createSlidingWindowRateLimiter`:

```ts
import {
  createChannelCore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  createSlidingWindowRateLimiter,
  rateLimitKey,
} from "@claxedo/channels"

// `access` here is the ChannelAccess built above.
const rateLimiter = createSlidingWindowRateLimiter({
  limit: 20,       // max events in the window
  windowMs: 60_000, // 1 minute sliding window
  maxKeys: 10_000,  // LRU-capped tracked senders (memory guard)
})

const core = createChannelCore({
  runtime,
  dedup: createMemoryDedupStore(),
  sessions: createMemorySessionResolver(runtime),
  access,
  rateLimiter,
  onDenial: (envelope, reason) => {
    // reason is a ChannelDenialReason OR the literal "rate_limited"
  },
})
```

Rate-limit keys are always `${channel}:${externalUserId}` (see
`rateLimitKey`) — a stable principal an attacker can't dodge by changing
message type or forward semantics. A rate-limited inbound is dropped silently
(no reply chunk), so the limiter itself can never be turned into an outbound
amplifier; only `onDenial` observes it.

## Provider Security Notes

### GitHub

Verify `X-Hub-Signature-256` with the webhook secret before passing the payload
to `githubWebhookEnvelope`.

```ts
import { githubWebhookEnvelope, verifyGitHubWebhookSignature } from "@claxedo/channels"

const body = await request.text()
if (!verifyGitHubWebhookSignature({
  body,
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
  signature: request.headers.get("x-hub-signature-256"),
})) {
  return new Response("invalid signature", { status: 401 })
}

const envelope = githubWebhookEnvelope({
  event: request.headers.get("x-github-event") ?? "",
  delivery: request.headers.get("x-github-delivery") ?? "",
  payload: JSON.parse(body),
})
```

Use a GitHub App with only the repository permissions needed for the workflows
you expose. Do not run channel commands from untrusted repos without an
authorization hook.

### Telegram

Telegram webhooks should use a secret token and compare the incoming
`X-Telegram-Bot-Api-Secret-Token` header before processing updates. The channel
registry only enables Telegram when a webhook secret token is configured.

### WhatsApp

Official WhatsApp webhooks should be verified by the mounted Chat SDK adapter or
caller-provided handler. Personal-mode Baileys auth state is local credential
material; store it with the same care as a session secret and do not share it
between unrelated tenants.

### Chat SDK Adapters

Chat SDK adapters are mounted as provider webhooks. Keep adapter package
versions in lockstep, configure provider secrets in the adapter, and keep the
bot account scoped to the channels/workspaces it is meant to control.

## Least-Privilege Example

```ts
import {
  createChannelAccess,
  createChannelCore,
  createMemoryChannelAccessStore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  createSlidingWindowRateLimiter,
  type ChannelRuntime,
} from "@claxedo/channels"

declare const runtime: ChannelRuntime // your session/prompt runtime binding

const access = createChannelAccess({
  dmPolicy: "pairing",
  groupPolicy: "allowlist",
  store: createMemoryChannelAccessStore(), // swap for durable storage in multi-instance deployments
})

const core = createChannelCore({
  runtime,
  dedup: createMemoryDedupStore(),
  sessions: createMemorySessionResolver(runtime),
  access, // runs first: unpaired/unallowlisted senders never reach authorize/dedup/the runtime
  rateLimiter: createSlidingWindowRateLimiter({ limit: 20, windowMs: 60_000 }),
  onDenial: (envelope, reason) => {
    console.warn("channel denial", { channel: envelope.channel, reason })
  },
  authorize: async (envelope) => {
    if (envelope.channel !== "github") return { ok: false, message: "Unsupported channel." }
    if (envelope.repo?.owner !== "acme") return { ok: false, message: "Repository is not linked." }
    return { ok: true }
  },
})
```

## Development

```sh
bun run --cwd packages/claxedo-channels typecheck
bun run --cwd packages/claxedo-channels test
bun run --cwd packages/claxedo-channels build
```
