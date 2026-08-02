# `@claxedo/channels` architecture

This package converts channel-native messages (GitHub webhooks, Telegram
updates, Chat SDK events, WhatsApp Baileys sockets) into one shared
`InboundEnvelope` shape, runs that envelope through a fixed pipeline in
`ChannelCore.handleInbound`, and streams the runtime's response back out as
`OutboundChunk`s. This doc covers the pipeline order and the trust boundary
between "transport" (channel-specific, untrusted) and "core" (channel-agnostic,
trusted) code.

## The `InboundEnvelope` pipeline

Every transport normalizes into `InboundEnvelope` (`src/envelope.ts`) before
calling `core.handleInbound(envelope, { reply })`. `handleInbound`
(`src/core/command-emit.ts`) then runs the following steps, in this order, for
every inbound message:

1. **Access gate** (`access: ChannelAccess`, optional) — `src/core/access.ts`.
   Runs first, before anything else. `access.gate(envelope)` returns either
   `{ admission: "allow" }` or `{ admission: "drop", reason, reply? }`. On
   `"drop"`, `onDenial` fires for an owner-side audit and, only for the
   throttled pairing offer, a single reply chunk is sent — the pipeline stops
   here. Skipped entirely when `envelope.trustedSource === true` (the loopback
   fake transport only; never set this from a real webhook).
2. **Per-sender rate limit** (`rateLimiter: RateLimiter`, optional) —
   `src/core/rate-limit.ts`. Checked immediately after the access gate, keyed
   on `rateLimitKey(channel, externalUserId)`. A limited sender is dropped
   silently (`onDenial` fires with `"rate_limited"`; no reply chunk is sent —
   the limiter itself must never become an outbound amplifier). Also skipped
   when `trustedSource === true`.
3. **Identity / lifecycle commands that need no session** — `whoami`,
   `pairing_list`, `pairing_approve` (gated by `canAdminister`), and
   `list_sessions` are answered directly and return early.
4. **Existing session lookup** — `sessions.get(envelope.threadKey)` fetches
   any session already bound to this thread. `status` and `new_session`
   intents are handled here and return early (`new_session` preempts an
   in-flight turn with `runtime.abortSession` rather than queuing behind it).
5. **`authorize` hook** (optional) — the caller-supplied least-privilege check
   (repo linkage, org membership, workspace binding). Runs after the access
   gate/rate-limit/built-in commands but before dedup, budget, or any
   session/runtime work. A refusal replies once with the hook's message.
6. **`budget` veto** (optional) — checked only for `action === "message"`
   turns, after `authorize`, before dedup. A refusal replies once.
7. **Dedup / replay + daily-ceiling claim** (`dedup: DedupStore`) —
   `src/core/dedup.ts`. `dedup.claim` rejects deliveries outside the
   per-channel replay window or over the daily session-create ceiling, and
   collapses duplicate deliveries of the same `idempotencyKey` into a single
   `{ kind: "status", phase: "done" }` reply instead of re-running the turn.
8. **Approval / cancel intents** — resolved against the `approvals` bridge or
   `runtime.abortSession` using the session found in step 4; these do not go
   through session *resolution* (step 9), only session *lookup*. A structured
   `approval_reply` (button press) decides directly. Otherwise, if a `judge` is
   configured and a prompt is pending in this thread, the message text is put
   to the judge: approved / denied / unclear, where unclear re-asks and leaves
   the prompt pending. A pending prompt classifies the turn as `"approval"` for
   `authorize` and the budget veto, so answering a prompt is never billed or
   gated as a fresh message turn.
9. **Session resolution** (`sessions: SessionResolver`) —
   `src/core/resolve-session.ts`. `sessions.resolve(envelope)` creates a new
   runtime session on first contact for a thread or returns the existing one;
   concurrent resolves for the same `threadKey` collapse onto one in-flight
   creation.
10. **Runtime dispatch** — `runtime.sendMessage(...)` is invoked and its
    event stream is converted to `OutboundChunk`s by `streamRuntimeReplies`
    (`src/core/reply-sink.ts`), which also renders any pending approval
    prompts through the `approvals` bridge.

Steps 1–2 are the trust boundary: everything before them is
channel/transport-specific parsing, and everything from step 3 onward assumes
the sender has already been admitted. A denial at step 1 or 2 never reaches
dedup, session state, or the runtime — an unpaired stranger or a flooding
allowed sender cannot cost more than the fixed, bounded work described in
`access.ts` and `rate-limit.ts`.

`onApproval` (used for out-of-band approval decisions, e.g. a button click
routed outside the normal inbound flow) does not run this pipeline — it goes
straight to the `approvals` bridge, since the access/rate-limit/dedup
questions were already answered when the original message that produced the
approval prompt was admitted.

## How each transport normalizes into `InboundEnvelope`

`createChannelRegistry` (`src/registry.ts`) decides, per channel and per
environment, which transport kind mounts a channel: `"chat-sdk"` (github,
telegram, slack, discord, whatsapp-official), `"baileys"`
(whatsapp-personal), or `"fake"` (local dev/test only).

- **Chat SDK adapters** (github/slack/telegram/discord/whatsapp-official) —
  `src/transport/chat-sdk-adapters.ts` dynamically imports the matching
  `@chat-adapter/*` package and wires it into the `chat` SDK's `Chat`
  constructor; `createChatSdkBridge` (`src/transport/chat-sdk-bridge.ts`)
  subscribes to `onNewMention`/`onSubscribedMessage` and normalizes each
  `(thread, message)` pair through `chatSdkEnvelope`. `threadKey` is built
  per-channel from installation/team/guild + conversation/channel + thread
  root identifiers; `idempotencyKey` falls back to
  `${threadKey}:${receivedAt}:${text}` when the SDK message has no stable id.
  Provider webhook signature verification is the Chat SDK adapter's
  responsibility, not this package's.
- **GitHub (direct)** — `src/transport/github.ts`'s `githubWebhookEnvelope`
  is for callers building their own webhook route instead of using the Chat
  SDK adapter. It only emits an envelope for `issue_comment`,
  `pull_request_review`, or `issues` events that `@mention` the bot name, and
  requires a `repository`, an issue/PR `number`, and a `sender.login`;
  `verifyGitHubWebhookSignature` (HMAC-SHA256 over `X-Hub-Signature-256`,
  timing-safe compare) must be called by the caller before parsing the JSON
  body — this package does not verify webhook signatures itself.
- **Telegram (direct)** — `src/transport/telegram.ts`'s
  `telegramUpdateEnvelope` is the direct-webhook counterpart to the Chat SDK
  path, for callers not using `@chat-adapter/telegram`. It reads
  `message`/`edited_message`/`channel_post`, derives `externalUserId` from
  `from.id` (falling back to `from.username`, then the chat id), and does not
  itself verify Telegram's `X-Telegram-Bot-Api-Secret-Token` header — the
  caller (or `createChannelRegistry`, which only enables Telegram once a
  webhook secret env var is set) is responsible for that.
- **WhatsApp personal (Baileys)** — `src/transport/whatsapp-baileys.ts`'s
  `createWhatsAppBaileysTransport` wraps a `WhatsAppBaileysSocket`
  (`src/transport/whatsapp-baileys-socket.ts` builds one from
  `@whiskeysockets/baileys`), normalizes each inbound message directly (no
  webhook signature step — trust is the local device pairing itself), and
  drops messages that are `fromMe` or have no text. Baileys auth state is
  local credential material and must be stored with the same care as a
  session secret.
- **Chat SDK envelope helper without the bridge** —
  `chatSdkEnvelope` is also exported standalone (`src/index.ts`) for callers
  that want the same normalization logic but drive delivery/subscription
  themselves instead of using `createChatSdkBridge`.
- **Fake transport** — `src/transport/fake.ts` (mounted only when
  `includeFake` is set) is the loopback-gated local injection path; envelopes
  built through it may set `trustedSource: true` to skip the access gate and
  rate limiter. This path must never be reachable from a real external
  network.

Regardless of transport, every normalizer runs inbound text through
`parseChannelCommand` (`src/core/channel-command.ts`) to populate
`envelope.intent` (message / cancel / new_session / list_sessions / status /
whoami / pairing_approve / pairing_list) before the envelope ever reaches
`ChannelCore`. Leading bot mentions are stripped first — GitHub only builds an
envelope when the body mentions the bot, so every GitHub body starts with
`@claxedo` and no `^`-anchored command would otherwise match.

`parseChannelCommand` deliberately does NOT produce `approval_reply`. That
intent is set only by a structured button press (`chatSdkApprovalDecision`).
Free-text approvals are classified by the judge inside `ChannelCore`, which
sees the pending prompt and the conversation; a regex over prose cannot tell
"no thanks" (a message) from "no" (a denial).

## Trust boundary summary

- **Untrusted / transport-owned**: webhook signature verification, payload
  shape parsing, `InboundEnvelope` construction, `raw` payload retention.
  Nothing here is assumed authorized.
- **Trust decision / core-owned**: the access gate (step 1) is the only place
  that turns "a message arrived on some channel" into "this sender may
  proceed." It is fail-closed — an unset `access`, an errored store lookup,
  or an `identity_blocked` binding must not silently admit.
- **Trusted / core-owned, post-gate**: rate limiting, dedup/replay,
  authorize/budget hooks, session resolution, and runtime dispatch all assume
  the sender already passed the gate.
- **Explicit escape hatch**: `envelope.trustedSource` bypasses both the
  access gate and the rate limiter. It exists only for the local fake
  transport used in dev/test loopback flows and must never be set from
  externally-reachable code.
