export type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ChannelChatType,
  ChannelId,
  ChannelIntent,
  InboundEnvelope,
  OutboundChunk,
} from "./envelope"
export {
  createChannelAccess,
  createMemoryChannelAccessStore,
  createMemoryChannelIdentityBindingStore,
  generatePairingCode,
  parseDmPolicy,
  parseGroupEngagement,
  parseGroupPolicy,
  seedAllows,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_PENDING_PER_CHANNEL,
  PAIRING_RESEND_INTERVAL_MS,
  type ChannelAccess,
  type ChannelAccessDecision,
  type ChannelAccessStore,
  type ChannelDenialReason,
  type ChannelDmPolicy,
  type ChannelGroupEngagement,
  type ChannelGroupPolicy,
  type ChannelIdentityBinding,
  type ChannelIdentityBindingStore,
  type PairingRequest,
} from "./core/access"
export { createMemoryDedupStore, type DedupDecision, type DedupStore } from "./core/dedup"
export {
  ChannelSessionResolutionError,
  createMemorySessionResolver,
  type ChannelRuntime,
  type SessionRef,
  type SessionResolver,
} from "./core/resolve-session"
export { createMemoryApprovalBridge, type ApprovalBridge } from "./core/approval-bridge"
export { sanitizeChannelText, type ChannelTextMinimizationOptions } from "./core/data-minimization"
export { createChannelCore, type ChannelCore, type ChannelSessionSummary } from "./core/command-emit"
export { createSlidingWindowRateLimiter, rateLimitKey, type RateLimiter, type RateLimitDecision, type RateLimitOptions } from "./core/rate-limit"
export { streamRuntimeReplies } from "./core/reply-sink"
export { parseChannelCommand } from "./core/channel-command"
export {
  runApprovalJudge,
  APPROVAL_JUDGE_TIMEOUT_MS,
  APPROVAL_UNCLEAR_REPLY,
  type ApprovalJudge,
  type ApprovalJudgeInput,
  type ApprovalJudgeTurn,
  type ApprovalJudgeVerdict,
} from "./core/approval-judge"
export { createChannelsIngress, type ChannelWebhookBot, type ChannelWebhookHandler } from "./ingress"
export { createChannelRegistry, type ChannelRegistration, type ChannelTransportKind } from "./registry"
export { createChatSdkBot, createChatSdkChannelBot } from "./transport/chat-sdk-adapters"
export { chatSdkApprovalDecision } from "./transport/chat-sdk-actions"
export { channelRetryDelayMs, type RetryAfterMs } from "./transport/backpressure"
export { createChatSdkBridge, chatSdkEnvelope, type ChatSdkBot, type ChatSdkBridgeThread, type ChatSdkMessage } from "./transport/chat-sdk-bridge"
export { createChatSdkRenderer, type ChatSdkMessageHandle, type ChatSdkThread } from "./transport/chat-sdk-render"
export { githubWebhookEnvelope, verifyGitHubWebhookSignature } from "./transport/github"
export { telegramUpdateEnvelope } from "./transport/telegram"
export {
  createBaileysWhatsAppSocket,
  type BaileysWhatsAppSocketOptions,
} from "./transport/whatsapp-baileys-socket"
export {
  createWhatsAppBaileysTransport,
  type WhatsAppBaileysAuthStateStore,
  type WhatsAppBaileysInboundMessage,
  type WhatsAppBaileysSocket,
  type WhatsAppBaileysTransport,
} from "./transport/whatsapp-baileys"
