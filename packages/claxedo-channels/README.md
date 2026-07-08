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
  createChannelCore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  type ChannelRuntime,
} from "@claxedo/channels"

declare const runtime: ChannelRuntime // your session/prompt runtime binding

const core = createChannelCore({
  runtime,
  dedup: createMemoryDedupStore(),
  sessions: createMemorySessionResolver(runtime),
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
