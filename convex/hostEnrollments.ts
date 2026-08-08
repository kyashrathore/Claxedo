import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  serviceMutation,
  serviceQuery,
  upsertServiceUser,
  upsertUser,
  userByTokenIdentifier,
} from "./model"

/**
 * Machine-wide remote access.
 *
 * `localHostLinks.ts` does the same four things per WORKSPACE. This does them
 * per MACHINE, and every difference between the two files is the removal of
 * workspace handling: no ownership check against a workspace doc, no
 * cloud-workspace refusal, and — the one that matters — no implicit workspace
 * insert. Enrolling a laptop creates nothing to own.
 *
 * Unit 6's hard cut replaces that file with this one. Until the cutover runbook
 * runs, both exist; `docs/tech-docs/host-enrollment-hard-cut-runbook.md` is the
 * only supported way to retire the old one, and there is deliberately no
 * compatibility mode reading both.
 */

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000
const REQUEST_TTL_MS = 60_000

const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function base64url(bytes: Uint8Array) {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64urlBytes(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const value = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return Uint8Array.from(value, (char) => char.charCodeAt(0))
}

/**
 * Signed payloads carry their own domain prefix.
 *
 * Distinct from `claxedo.local-host-link.*`: a signature captured from one flow
 * must not be replayable in the other, and the prefix is what prevents it.
 */
function enrollmentPayload(input: { host_id: string; request_id: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.host_id}`,
    `request_id=${input.request_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: { host_id: string; ttl_ms?: number }) {
  return ["claxedo.host-enrollment.heartbeat.v1", `host_id=${input.host_id}`, `ttl_ms=${input.ttl_ms ?? ""}`].join("\n")
}

async function verifyHostSignature(input: { public_key: string; payload: string; signature: string }) {
  const jwk = JSON.parse(input.public_key)
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") throw new Error("Invalid host public key")
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlBytes(input.signature),
      new TextEncoder().encode(input.payload),
    ))
  ) {
    throw new Error("Invalid host attestation")
  }
}

/** Row → what an owner may see. The public key never crosses this boundary. */
function toEnrollment(row: {
  enrollment_id: string
  host_id: string
  display_name?: string
  expires_at: number
  last_seen_at: number
  created_at: number
}) {
  return {
    enrollment_id: row.enrollment_id,
    host_id: row.host_id,
    ...(row.display_name ? { display_name: row.display_name } : {}),
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  }
}

function enrollmentByOwnerHost(ctx: any, user: { _id: unknown }, host_id: string) {
  return ctx.db
    .query("host_enrollments")
    .withIndex("by_owner_host", (q: any) => q.eq("owner_user_id", user._id).eq("host_id", host_id))
    .unique()
}

async function createRequestForUser(ctx: any, user: { _id: unknown }, args: { host_id: string }) {
  const now = Date.now()
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const request_id = base64url(crypto.getRandomValues(new Uint8Array(16)))
  await ctx.db.insert("host_enrollment_requests", {
    request_id,
    owner_user_id: user._id,
    host_id: args.host_id,
    nonce,
    expires_at: now + REQUEST_TTL_MS,
    created_at: now,
  })
  return { request_id, nonce, expires_at: now + REQUEST_TTL_MS }
}

async function enrollForUser(
  ctx: any,
  user: { _id: unknown },
  args: {
    host_id: string
    public_key: string
    request_id: string
    signature: string
    display_name?: string
    ttl_ms?: number
  },
) {
  const now = Date.now()
  const request = await ctx.db
    .query("host_enrollment_requests")
    .withIndex("by_request_id", (q: any) => q.eq("request_id", args.request_id))
    .unique()
  if (
    !request
    || request.owner_user_id !== user._id
    || request.host_id !== args.host_id
    || request.used_at
    || request.expires_at <= now
  ) {
    throw new Error("Invalid host enrollment request")
  }

  // Verified before the nonce is claimed, matching the SQLite authority where
  // that ordering is what stops a bad signature from burning the request.
  //
  // Here it is belt and braces rather than the mechanism: a Convex mutation is
  // transactional, so a throw below rolls the patch back regardless of order.
  // The ordering is kept anyway so the two authorities read the same, and so
  // that a future refactor which splits this across mutations does not silently
  // lose the property. (Verified: reordering these two lines does not fail the
  // policy test, which is the honest reason this note exists.)
  await verifyHostSignature({
    public_key: args.public_key,
    payload: enrollmentPayload({ host_id: args.host_id, request_id: args.request_id, nonce: request.nonce }),
    signature: args.signature,
  })
  await ctx.db.patch(request._id, { used_at: now })

  const expires_at = now + ttl(args.ttl_ms)
  const existing = await enrollmentByOwnerHost(ctx, user, args.host_id)
  if (existing) {
    // Patched, never inserted again: Convex has no unique constraint, so the
    // one-row-per-machine rule lives in this read-then-patch. Re-enrolling
    // clears a previous pause or revoke — the user just proved possession of
    // the key again, which is a stronger statement than either flag.
    await ctx.db.patch(existing._id, {
      public_key: args.public_key,
      ...(args.display_name ? { display_name: args.display_name } : {}),
      last_seen_at: now,
      expires_at,
      updated_at: now,
      paused_at: undefined,
      paused_by: undefined,
      paused_reason: undefined,
      revoked_at: undefined,
    })
    return toEnrollment({ ...existing, ...(args.display_name ? { display_name: args.display_name } : {}), expires_at, last_seen_at: now })
  }

  const enrollment_id = base64url(crypto.getRandomValues(new Uint8Array(16)))
  await ctx.db.insert("host_enrollments", {
    enrollment_id,
    owner_user_id: user._id,
    host_id: args.host_id,
    public_key: args.public_key,
    ...(args.display_name ? { display_name: args.display_name } : {}),
    last_seen_at: now,
    expires_at,
    created_at: now,
    updated_at: now,
  })
  return toEnrollment({
    enrollment_id,
    host_id: args.host_id,
    ...(args.display_name ? { display_name: args.display_name } : {}),
    expires_at,
    last_seen_at: now,
    created_at: now,
  })
}

async function heartbeatForUser(
  ctx: any,
  user: { _id: unknown },
  args: { host_id: string; signature: string; ttl_ms?: number },
) {
  const row = await enrollmentByOwnerHost(ctx, user, args.host_id)
  if (!row || row.revoked_at) throw new Error("Host enrollment not found")
  await verifyHostSignature({
    public_key: row.public_key,
    payload: heartbeatPayload({ host_id: args.host_id, ttl_ms: args.ttl_ms }),
    signature: args.signature,
  })
  const now = Date.now()
  const expires_at = now + ttl(args.ttl_ms)
  await ctx.db.patch(row._id, { last_seen_at: now, expires_at, updated_at: now })
  return { expires_at, last_seen_at: now }
}

async function pauseForUser(ctx: any, user: { _id: unknown }, args: { host_id?: string; paused: boolean }) {
  const now = Date.now()
  const patch = args.paused
    ? { paused_at: now, paused_by: "user" as const, paused_reason: "user_paused", updated_at: now }
    : { paused_at: undefined, paused_by: undefined, paused_reason: undefined, updated_at: now }

  // No host id pauses every machine this owner enrolled — the "stop all remote
  // access" the settings switch means. Scoped to the owner's index either way,
  // so it can never reach another user's machines.
  const rows = args.host_id
    ? [await enrollmentByOwnerHost(ctx, user, args.host_id)].filter(Boolean)
    : await ctx.db
        .query("host_enrollments")
        .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
        .collect()
  for (const row of rows) await ctx.db.patch(row._id, patch)
  return { paused: args.paused, count: rows.length }
}

async function activeForUser(ctx: any, user: { _id: unknown }) {
  const rows = await ctx.db
    .query("host_enrollments")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", user._id))
    .collect()
  const row = rows.sort((a: any, b: any) => b.last_seen_at - a.last_seen_at)[0]
  if (!row) return { active: false as const, reason: "not-enrolled" as const }
  // Most-specific first: a revoked enrollment also expires eventually, and
  // reporting the expiry would tell the user to reconnect when the real answer
  // is that access was taken away.
  if (row.revoked_at) return { active: false as const, reason: "revoked" as const }
  if (row.paused_at) return { active: false as const, reason: "paused" as const }
  if (row.expires_at <= Date.now()) return { active: false as const, reason: "expired" as const }
  return { active: true as const, ...toEnrollment(row) }
}

const hostId = { host_id: v.string() }
const enrollArgs = {
  ...hostId,
  public_key: v.string(),
  request_id: v.string(),
  signature: v.string(),
  display_name: v.optional(v.string()),
  ttl_ms: v.optional(v.number()),
}

export const createRequest = authedMutation({
  args: hostId,
  handler: async (ctx, args) => createRequestForUser(ctx, await upsertUser(ctx), args),
})

export const enroll = authedMutation({
  args: enrollArgs,
  handler: async (ctx, args) => enrollForUser(ctx, await upsertUser(ctx), args),
})

export const heartbeat = authedMutation({
  args: { ...hostId, signature: v.string(), ttl_ms: v.optional(v.number()) },
  handler: async (ctx, args) => heartbeatForUser(ctx, await upsertUser(ctx), args),
})

export const pause = authedMutation({
  args: { host_id: v.optional(v.string()), paused: v.boolean() },
  handler: async (ctx, args) => pauseForUser(ctx, await upsertUser(ctx), args),
})

export const active = authedQuery({
  args: {},
  handler: async (ctx) => {
    // A QUERY, so it looks the user up rather than upserting — `upsertUser`
    // writes, and a query context has no `patch`. A caller who has never signed
    // in simply has nothing enrolled; that is an answer, not an error.
    const user = await userByTokenIdentifier(ctx.db, ctx.identity.tokenIdentifier)
    if (!user) return { active: false as const, reason: "not-enrolled" as const }
    return activeForUser(ctx, user)
  },
})

// Service variants: Hosted Server calls these on behalf of a user it has
// already authenticated, exactly as the local-host-link module does.
export const createRequestForService = serviceMutation({
  args: { user: serviceUser, ...hostId },
  handler: async (ctx, args) => createRequestForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const enrollForService = serviceMutation({
  args: { user: serviceUser, ...enrollArgs },
  handler: async (ctx, args) => enrollForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const heartbeatForService = serviceMutation({
  args: { user: serviceUser, ...hostId, signature: v.string(), ttl_ms: v.optional(v.number()) },
  handler: async (ctx, args) => heartbeatForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const pauseForService = serviceMutation({
  args: { user: serviceUser, host_id: v.optional(v.string()), paused: v.boolean() },
  handler: async (ctx, args) => pauseForUser(ctx, await upsertServiceUser(ctx, args.user), args),
})

export const activeForService = serviceQuery({
  args: { user: serviceUser },
  handler: async (ctx, args) => {
    // A QUERY, so it cannot upsert the user the way the mutations above do —
    // it looks the user up instead. A caller asking about a user who has never
    // signed in is not an error worth throwing for; there is simply nothing
    // enrolled.
    const user = await userByTokenIdentifier(ctx.db, args.user.token_identifier)
    if (!user) return { active: false as const, reason: "not-enrolled" as const }
    return activeForUser(ctx, user)
  },
})
