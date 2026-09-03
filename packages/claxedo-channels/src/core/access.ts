/**
 * Channel access control — DM/group policy, pairing, and channel→account
 * identity binding.
 *
 * The invariants this module depends on:
 *
 *   - Gate runs BEFORE dedup / session / any LLM call. Forwarding to the agent
 *     before the policy check leaks private content regardless of how correct
 *     the policy itself is; placement is the whole ballgame.
 *   - FAIL CLOSED. A config or merge bug must never land on a permissive
 *     default. Unknown policy → strictest interpretation; an errored store →
 *     deny, not allow.
 *   - IMMUTABLE IDS ONLY. A mutable @username or display name is reassignable
 *     and spoofable, so it can never be the access key. The binding key is the
 *     platform's stable numeric/opaque id.
 *   - OBSERVABLE DENIALS. Blocked messages emit a structured reason for an
 *     owner-side audit; they do NOT auto-reply to the stranger, since a reply
 *     is an amplifier and confirms the bot exists. The one exception is the
 *     pairing code itself, throttled hard.
 *   - BOUNDED, PER-PRINCIPAL COST. A stranger who discovers the bot can cost at
 *     most one throttled pairing reply + one bounded pending row — no LLM, no
 *     tools, no media fetch. Pairing queue is capped PER CHANNEL and pending
 *     rows are per (channel, sender), so abuse accounting stays on stable
 *     principals rather than on anything the sender can vary.
 *
 * Scope: storage is a PORT backed by the control plane's SQLite, approval rides
 * a bearer-gated route AND in-chat `/pairing approve`, and pairing binds to a
 * REAL Claxedo account so that "which human said this?" has an answer in a
 * multi-user deployment.
 */
import { randomInt } from "node:crypto"
import type { ChannelChatType, ChannelId, InboundEnvelope } from "../envelope"

export type ChannelDmPolicy = "disabled" | "allowlist" | "pairing" | "open"
export type ChannelGroupPolicy = "disabled" | "allowlist" | "open"

/**
 * Whether the bot answers every group message or only the ones addressed to it.
 *
 * ACCESS and ENGAGEMENT are different questions. Access asks "may this sender
 * use the bot at all"; engagement asks "was the bot spoken to". A group can
 * hold a hundred people talking to each other, so an allowlisted member typing
 * in a shared room is not automatically making a request — answering anyway
 * turns every group into a firehose of turns nobody asked for, and forwards
 * unrelated conversation into a session transcript.
 *
 * `mention` (default): only messages carrying a bot mention are engaged.
 * `unprompted`: every group message from an admitted sender is engaged. Opt in
 * only for a room dedicated to the bot.
 */
export type ChannelGroupEngagement = "mention" | "unprompted"

export type PairingRequest = {
  code: string
  channel: ChannelId
  externalUserId: string
  createdAt: number
  expiresAt: number
  lastSentAt: number
}

/** A channel sender bound to a Claxedo account (multi-user identity). */
export type ChannelIdentityBinding = {
  channel: ChannelId
  externalUserId: string
  /** Null while the sender is paired but has not yet linked an account. */
  accountId: string | null
  status: "pending" | "bound" | "blocked"
  boundAt: number
  boundBy?: string
}

/** Persistence port for pairing state + allow entries (SQLite in the server). */
export type ChannelAccessStore = {
  isAllowed(channel: ChannelId, externalUserId: string): Promise<boolean>
  allow(channel: ChannelId, externalUserId: string, approvedBy: string): Promise<void>
  disallow(channel: ChannelId, externalUserId: string): Promise<void>
  listPending(channel?: ChannelId): Promise<PairingRequest[]>
  findPending(code: string): Promise<PairingRequest | undefined>
  findPendingBySender(channel: ChannelId, externalUserId: string): Promise<PairingRequest | undefined>
  putPending(request: PairingRequest): Promise<void>
  deletePending(code: string): Promise<void>
}

/** Persistence port for channel→account bindings. */
export type ChannelIdentityBindingStore = {
  get(channel: ChannelId, externalUserId: string): Promise<ChannelIdentityBinding | undefined>
  listBoundForAccount(accountId: string): Promise<ChannelIdentityBinding[]>
  put(binding: ChannelIdentityBinding): Promise<void>
  delete(channel: ChannelId, externalUserId: string): Promise<void>
}

/** Why an inbound was refused — logged to an owner-visible audit, not the sender. */
export type ChannelDenialReason =
  | "dm_disabled"
  | "dm_not_allowlisted"
  | "dm_pairing_required"
  | "dm_pairing_throttled"
  | "dm_pairing_queue_full"
  | "group_disabled"
  | "group_not_allowlisted"
  | "group_not_addressed"
  | "identity_blocked"

export type ChannelAccessDecision =
  | { admission: "allow"; binding?: ChannelIdentityBinding }
  // "drop": silently refused; `reason` for the owner audit; `reply` is set ONLY
  // for the throttled pairing offer (the single sanctioned stranger-facing text).
  | { admission: "drop"; reason: ChannelDenialReason; reply?: string }

export type ChannelAccess = {
  dmPolicy: ChannelDmPolicy
  groupPolicy: ChannelGroupPolicy
  groupEngagement: ChannelGroupEngagement
  /** Gate an inbound envelope. Call this FIRST, before any other work. */
  gate(envelope: Pick<InboundEnvelope, "channel" | "externalUserId" | "chatType" | "mentions">): Promise<ChannelAccessDecision>
  /** Approve a pending pairing code; records the approver for audit. */
  approve(
    code: string,
    approvedBy: string,
    bind?: (identity: { channel: ChannelId; externalUserId: string }) => Promise<{ accountId: string; boundBy: string }>,
  ): Promise<
    | { ok: true; channel: ChannelId; externalUserId: string }
    | { ok: false; message: string }
  >
  /** Remove the local allow/binding projection after canonical revocation. */
  revoke(channel: ChannelId, externalUserId: string): Promise<void>
  listPending(channel?: ChannelId): Promise<PairingRequest[]>
}

// The resend interval matches the code TTL, so an unpaired stranger draws at
// most one pairing reply per code lifetime. The pending cap bounds how many
// codes a channel can hold at once — a handful is enough for real pairing while
// keeping a flood's footprint fixed.
export const PAIRING_CODE_TTL_MS = 60 * 60 * 1000
export const PAIRING_RESEND_INTERVAL_MS = 60 * 60 * 1000
export const PAIRING_MAX_PENDING_PER_CHANNEL = 3
/**
 * Unambiguous alphabet: no 0/O, 1/I. 8 chars ≈ 40 bits drawn from the platform
 * CSPRNG — fine for a 1h TTL + throttle. The entropy claim is what makes the
 * code a credential, so the source must be unpredictable: `Math.random` is a
 * seeded xorshift whose state is recoverable from observed output, which would
 * make later codes derivable from earlier ones.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function generatePairingCode(random?: () => number) {
  // `randomInt` rejects out-of-range draws, so the default is unbiased; an
  // injected [0,1) source (tests) also maps exactly, the alphabet being 2^5.
  const index = random ? () => Math.floor(random() * CODE_ALPHABET.length) : () => randomInt(0, CODE_ALPHABET.length)
  return Array.from({ length: 8 }, () => CODE_ALPHABET[index()]).join("")
}

/** Config-seed match: "telegram:12345", "telegram:*", or "*". Immutable ids only. */
export function seedAllows(seed: string[] | undefined, channel: ChannelId, externalUserId: string): boolean {
  if (!seed || seed.length === 0) return false
  const exact = `${channel}:${externalUserId}`
  return seed.some((entry) => {
    const value = entry.trim()
    if (!value) return false
    if (value === "*") return true
    if (value === `${channel}:*`) return true
    return value === exact
  })
}

export function parseDmPolicy(input: string | undefined, fallback: ChannelDmPolicy = "pairing"): ChannelDmPolicy {
  const value = input?.trim().toLowerCase()
  if (value === "pairing" || value === "allowlist" || value === "open" || value === "disabled") return value
  return fallback
}

export function parseGroupPolicy(input: string | undefined, fallback: ChannelGroupPolicy = "allowlist"): ChannelGroupPolicy {
  const value = input?.trim().toLowerCase()
  if (value === "allowlist" || value === "open" || value === "disabled") return value
  return fallback
}

/** Unknown value → "mention", the quieter of the two (fail-closed on config typos). */
export function parseGroupEngagement(
  input: string | undefined,
  fallback: ChannelGroupEngagement = "mention",
): ChannelGroupEngagement {
  const value = input?.trim().toLowerCase()
  if (value === "mention" || value === "unprompted") return value
  return fallback
}

export function createMemoryChannelAccessStore(): ChannelAccessStore {
  const allowed = new Set<string>()
  const pending = new Map<string, PairingRequest>()
  return {
    async isAllowed(channel, externalUserId) {
      return allowed.has(`${channel}:${externalUserId}`)
    },
    async allow(channel, externalUserId) {
      allowed.add(`${channel}:${externalUserId}`)
    },
    async disallow(channel, externalUserId) {
      allowed.delete(`${channel}:${externalUserId}`)
    },
    async listPending(channel) {
      return [...pending.values()].filter((item) => !channel || item.channel === channel)
    },
    async findPending(code) {
      return pending.get(code)
    },
    async findPendingBySender(channel, externalUserId) {
      return [...pending.values()].find((item) => item.channel === channel && item.externalUserId === externalUserId)
    },
    async putPending(request) {
      pending.set(request.code, request)
    },
    async deletePending(code) {
      pending.delete(code)
    },
  }
}

export function createMemoryChannelIdentityBindingStore(): ChannelIdentityBindingStore {
  const bindings = new Map<string, ChannelIdentityBinding>()
  const key = (channel: ChannelId, externalUserId: string) => `${channel}:${externalUserId}`
  return {
    async get(channel, externalUserId) {
      return bindings.get(key(channel, externalUserId))
    },
    async listBoundForAccount(accountId) {
      return [...bindings.values()].filter((binding) => binding.status === "bound" && binding.accountId === accountId)
    },
    async put(binding) {
      bindings.set(key(binding.channel, binding.externalUserId), binding)
    },
    async delete(channel, externalUserId) {
      bindings.delete(key(channel, externalUserId))
    },
  }
}

export function createChannelAccess(input: {
  dmPolicy: ChannelDmPolicy
  groupPolicy?: ChannelGroupPolicy
  /** Group engagement mode; defaults to "mention". See ChannelGroupEngagement. */
  groupEngagement?: ChannelGroupEngagement
  store: ChannelAccessStore
  bindings?: ChannelIdentityBindingStore
  /** Config-seeded always-allowed senders ("telegram:123", "telegram:*", "*"). */
  allowFrom?: string[]
  now?: () => number
  random?: () => number
}): ChannelAccess {
  const now = input.now ?? Date.now
  // Deny-by-default on the group surface: a group is a room full of people the
  // operator never approved individually, so "allowlist" (not "open") is the
  // only safe absent-config value.
  const groupPolicy = input.groupPolicy ?? "allowlist"
  const groupEngagement = input.groupEngagement ?? "mention"

  const isAllowed = async (channel: ChannelId, externalUserId: string) =>
    seedAllows(input.allowFrom, channel, externalUserId) || await input.store.isAllowed(channel, externalUserId)

  const pairingGate = async (channel: ChannelId, externalUserId: string): Promise<ChannelAccessDecision> => {
    const at = now()
    const existing = await input.store.findPendingBySender(channel, externalUserId)
    if (existing && existing.expiresAt > at) {
      // Resend throttle: a stranger cannot make the bot emit more than one
      // pairing reply per hour. Silence (not a second code) when throttled.
      if (at - existing.lastSentAt < PAIRING_RESEND_INTERVAL_MS) {
        return { admission: "drop", reason: "dm_pairing_throttled" }
      }
      await input.store.putPending({ ...existing, lastSentAt: at })
      return { admission: "drop", reason: "dm_pairing_required", reply: pairingReply(existing.code) }
    }
    if (existing) await input.store.deletePending(existing.code)
    const open = (await input.store.listPending(channel)).filter((item) => item.expiresAt > at)
    if (open.length >= PAIRING_MAX_PENDING_PER_CHANNEL) {
      // Bounded queue: a flood can't grow unboundedly or evict via memory.
      return { admission: "drop", reason: "dm_pairing_queue_full" }
    }
    const code = generatePairingCode(input.random)
    await input.store.putPending({
      code,
      channel,
      externalUserId,
      createdAt: at,
      expiresAt: at + PAIRING_CODE_TTL_MS,
      lastSentAt: at,
    })
    return { admission: "drop", reason: "dm_pairing_required", reply: pairingReply(code) }
  }

  return {
    dmPolicy: input.dmPolicy,
    groupPolicy,
    groupEngagement,
    async gate(envelope) {
      const chatType: ChannelChatType = envelope.chatType ?? "dm"
      // Explicit block always wins, both surfaces.
      const binding = await input.bindings?.get(envelope.channel, envelope.externalUserId)
      if (binding?.status === "blocked") return { admission: "drop", reason: "identity_blocked" }

      if (chatType === "group") {
        if (groupPolicy === "disabled") return { admission: "drop", reason: "group_disabled" }
        // ENGAGEMENT before access: an unaddressed group message is not a
        // request at all, so it should not consume a pairing slot, an audit
        // entry about a "denied" sender, or a rate-limit token. Checked here
        // rather than in the transports so every channel gets it once.
        if (groupEngagement === "mention" && !(envelope.mentions?.length)) {
          return { admission: "drop", reason: "group_not_addressed" }
        }
        if (groupPolicy === "open") return { admission: "allow", ...(binding ? { binding } : {}) }
        // allowlist: group senders must be explicitly allowed (immutable id).
        if (await isAllowed(envelope.channel, envelope.externalUserId)) {
          return { admission: "allow", ...(binding ? { binding } : {}) }
        }
        return { admission: "drop", reason: "group_not_allowlisted" }
      }

      // DM surface.
      if (input.dmPolicy === "open") return { admission: "allow", ...(binding ? { binding } : {}) }
      if (input.dmPolicy === "disabled") return { admission: "drop", reason: "dm_disabled" }
      if (await isAllowed(envelope.channel, envelope.externalUserId)) {
        return { admission: "allow", ...(binding ? { binding } : {}) }
      }
      if (input.dmPolicy === "allowlist") return { admission: "drop", reason: "dm_not_allowlisted" }
      return pairingGate(envelope.channel, envelope.externalUserId)
    },
    async approve(code, approvedBy, bind) {
      const at = now()
      const hit = await input.store.findPending(code.toUpperCase())
      if (!hit || hit.expiresAt <= at) {
        if (hit) await input.store.deletePending(hit.code)
        return { ok: false, message: "Unknown or expired pairing code." }
      }
      // The authenticated account binding is the authoritative producer. It
      // runs before the local allow/delete projection so a failed canonical
      // write never consumes the one-time pairing code. A retry safely repairs
      // a later local projection failure because canonical binds are idempotent.
      const linked = await bind?.({ channel: hit.channel, externalUserId: hit.externalUserId })
      await input.store.allow(hit.channel, hit.externalUserId, approvedBy)
      await input.store.deletePending(hit.code)
      // Legacy operator approval may admit the sender, but only an
      // authenticated claim can turn it into an account binding.
      await input.bindings?.put({
        channel: hit.channel,
        externalUserId: hit.externalUserId,
        accountId: linked?.accountId ?? null,
        status: linked ? "bound" : "pending",
        boundAt: at,
        boundBy: linked?.boundBy ?? approvedBy,
      })
      return { ok: true, channel: hit.channel, externalUserId: hit.externalUserId }
    },
    async revoke(channel, externalUserId) {
      // Both operations are idempotent. Canonical revocation runs before this
      // projection, so an interrupted request can safely repeat the route and
      // finish either local delete without re-authorizing the sender.
      await input.store.disallow(channel, externalUserId)
      await input.bindings?.delete(channel, externalUserId)
    },
    listPending: (channel) => input.store.listPending(channel),
  }
}

function pairingReply(code: string) {
  return [
    `This bot requires pairing. Your code: ${code}`,
    `An owner can approve it in an authorized chat with: /pairing approve ${code}`,
    "Your message was not processed.",
  ].join("\n")
}
