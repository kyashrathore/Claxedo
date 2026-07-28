/**
 * Durable revocation registry for CLI session tokens (`claxedo login`).
 *
 * These are the longest-lived bearer credentials Claxedo issues: they sit in a
 * file on a developer's laptop and authenticate every subsequent control-plane
 * call. A signature check can only answer "did we mint this and has it expired
 * yet"; this table is what makes "is it still allowed" answerable, and it must
 * be shared by every Worker isolate — a per-process cache would read tokens
 * minted elsewhere as unknown and would never see another instance's
 * revocations.
 *
 * ── Why not runtimeAccessTokens.ts ──
 * That table requires a `workspace_id` AND a `host_id` and matches `active` on
 * both, and its mutations are `authedMutation`s gated on `authorizeWorkspace`.
 * A CLI session token has no workspace and no host, and is minted at
 * `/api/auth/cli/exchange` BEFORE any workspace exists — so it cannot
 * authenticate a workspace-gated mutation at mint time. Different credential,
 * different table.
 *
 * ── Why the service builders ──
 * The decisive case is refresh ROTATION. `/api/auth/device/token` presents only
 * a CLI refresh token, which Convex cannot verify — there is no Clerk JWT on
 * that request at all — yet rotation must record the replacement pair and burn
 * the presented one. So the record/check/rotate path has to be authenticated as
 * the CONTROL PLANE (`serviceMutation`/`serviceQuery`), exactly like
 * `runtimeAccessTokens.recordMintForService` and `.active`. `publicMutation` is
 * categorically wrong here: the deployment URL ships in the client bundle, so a
 * public function is an internet-facing unauthenticated endpoint over session
 * tokens.
 *
 * ── Who may revoke what ──
 * Every service-authenticated revocation takes `token_identifier` and matches
 * on it, so a caller can only ever affect the owner it names; the control plane
 * fills that in from a VERIFIED auth context, never from request input. The
 * one end-user-facing function, `revokeMine`, takes no owner argument at all —
 * it reads `ctx.identity.tokenIdentifier`, which makes revoking somebody else's
 * sessions unrepresentable rather than merely forbidden. That closes the
 * obvious denial-of-service: there is no argument shape that names a victim.
 */

import { v } from "convex/values"
import { authedMutation, cronMutation, serviceMutation, serviceQuery } from "./model"

const kindValidator = v.union(v.literal("access"), v.literal("refresh"))

const recordFields = {
  jti: v.string(),
  kind: kindValidator,
  token_identifier: v.string(),
  subject: v.string(),
  session_id: v.string(),
  expires_at: v.number(),
  session_expires_at: v.number(),
}

const recordValidator = v.object(recordFields)

type TokenRecord = {
  jti: string
  kind: "access" | "refresh"
  token_identifier: string
  subject: string
  session_id: string
  expires_at: number
  session_expires_at: number
}

type Row = TokenRecord & { _id: any; revoked_at?: number; created_at: number }

async function rowByJti(ctx: { db: any }, jti: string) {
  return (await ctx.db
    .query("cli_session_tokens")
    .withIndex("by_jti", (q: any) => q.eq("jti", jti))
    .unique()) as Row | null
}

async function insertRecord(ctx: { db: any }, record: TokenRecord, now: number) {
  // A repeated `jti` is either a bug or a replay of a mint; either way the
  // second write must not silently shadow the first.
  if (await rowByJti(ctx, record.jti)) throw new Error("CLI session token already recorded")
  await ctx.db.insert("cli_session_tokens", { ...record, created_at: now })
}

/**
 * The verification-time answer, shaped as the control plane's registry record.
 *
 * Deliberately camelCase INSIDE `record` (unlike the snake_case args): this is
 * the `CliSessionTokenRecord` of the control-plane port crossing the wire, and
 * the adapter rejects anything it cannot read as a complete record.
 */
function activeRecord(row: Row) {
  return {
    active: true as const,
    record: {
      jti: row.jti,
      kind: row.kind,
      tokenIdentifier: row.token_identifier,
      subject: row.subject,
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      sessionExpiresAt: row.session_expires_at,
    },
  }
}

function inactive(code: string, reason: string) {
  return { active: false as const, code, reason }
}

/**
 * Evaluate one row against the presented token. Every non-`active` answer is a
 * rejection at the caller — "we could not confirm" is never "allow".
 */
function evaluate(row: Row | null, args: { kind: "access" | "refresh"; token_identifier: string }, now: number) {
  if (!row) return inactive("cli_session_token_unknown", "CLI session token has not been recorded")
  if (row.revoked_at) return inactive("cli_session_token_revoked", "CLI session token has been revoked")
  if (row.kind !== args.kind || row.token_identifier !== args.token_identifier) {
    return inactive("cli_session_token_mismatch", "CLI session token does not match its recorded kind or owner")
  }
  if (row.expires_at <= now || row.session_expires_at <= now) {
    return inactive("cli_session_token_expired", "CLI session token has expired")
  }
  return activeRecord(row)
}

async function revokeRows(ctx: { db: any }, rows: Row[], now: number) {
  const live = rows.filter((row) => !row.revoked_at)
  for (const row of live) await ctx.db.patch(row._id, { revoked_at: now })
  return { revoked: live.length }
}

async function rowsForUser(ctx: { db: any }, tokenIdentifier: string) {
  return (await ctx.db
    .query("cli_session_tokens")
    .withIndex("by_token_identifier", (q: any) => q.eq("token_identifier", tokenIdentifier))
    .collect()) as Row[]
}

async function rowsForSession(ctx: { db: any }, tokenIdentifier: string, sessionId: string) {
  return (await ctx.db
    .query("cli_session_tokens")
    .withIndex("by_user_session", (q: any) => q.eq("token_identifier", tokenIdentifier).eq("session_id", sessionId))
    .collect()) as Row[]
}

/** Record one minted token. Called once per token BEFORE it is handed out. */
export const recordMint = serviceMutation({
  args: recordFields,
  handler: async (ctx, args) => {
    await insertRecord(ctx, args as TokenRecord, Date.now())
    return { ok: true }
  },
})

/** Verification-time lookup. Anything other than `active: true` rejects. */
export const active = serviceQuery({
  args: {
    jti: v.string(),
    kind: kindValidator,
    token_identifier: v.string(),
  },
  handler: async (ctx, args) => evaluate(await rowByJti(ctx, args.jti), args, Date.now()),
})

/**
 * Rotate a login chain: burn the presented token and register its replacements
 * in ONE transaction.
 *
 * This is the whole reason rotation is not "mint, then revoke". Convex
 * mutations are serializable, so either the old `jti` is revoked and the new
 * pair exists, or neither happened. Two consequences the split version could
 * not give:
 *   - no replay window — there is never an instant where both the spent refresh
 *     token and its replacement verify, and a crash cannot leave the old token
 *     live forever;
 *   - no coverage gap — the new tokens are never registered unless the old one
 *     was still valid at burn time, so a concurrent second refresh presenting
 *     the same token loses the race and is rejected as revoked rather than
 *     forking the chain into two live credentials.
 * The re-validation below runs INSIDE the transaction for the same reason: the
 * caller's earlier `active` check is advisory, this one is authoritative.
 */
export const rotate = serviceMutation({
  args: {
    previous_jti: v.string(),
    token_identifier: v.string(),
    minted: v.array(recordValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const previous = await rowByJti(ctx, args.previous_jti)
    const status = evaluate(previous, { kind: "refresh", token_identifier: args.token_identifier }, now)
    if (!status.active) return { ok: false as const, code: status.code, reason: status.reason }
    // Owner-pinned: replacements inherit the burned token's owner, so a caller
    // cannot use a chain it holds to mint credentials for a different user.
    for (const record of args.minted as TokenRecord[]) {
      if (record.token_identifier !== args.token_identifier) {
        return {
          ok: false as const,
          code: "cli_session_token_mismatch",
          reason: "Rotated CLI session tokens must belong to the presented token's owner",
        }
      }
    }
    await ctx.db.patch(previous!._id, { revoked_at: now })
    for (const record of args.minted as TokenRecord[]) await insertRecord(ctx, record, now)
    return { ok: true as const }
  },
})

/** Revoke one token by `jti`, scoped to its owner so ids cannot be guessed across users. */
export const revoke = serviceMutation({
  args: {
    jti: v.string(),
    token_identifier: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await rowByJti(ctx, args.jti)
    if (!row || row.token_identifier !== args.token_identifier) return { revoked: 0 }
    return revokeRows(ctx, [row], Date.now())
  },
})

/** Revoke every token in one login chain (that device's session). */
export const revokeSession = serviceMutation({
  args: {
    session_id: v.string(),
    token_identifier: v.string(),
  },
  handler: async (ctx, args) =>
    revokeRows(ctx, await rowsForSession(ctx, args.token_identifier, args.session_id), Date.now()),
})

/** Revoke every token a user holds, on every device — the "lost my laptop" button. */
export const revokeForUser = serviceMutation({
  args: { token_identifier: v.string() },
  handler: async (ctx, args) => revokeRows(ctx, await rowsForUser(ctx, args.token_identifier), Date.now()),
})

/**
 * The end-user half of revoke-all: "sign me out of every CLI, everywhere".
 *
 * `authedMutation` rather than a service builder because the caller here is the
 * human, holding their own Clerk identity, with no control plane in the middle.
 * It takes NO owner argument on purpose — the owner is `ctx.identity`, so the
 * function has no way to express "revoke someone else's sessions" and needs no
 * check to forbid it.
 */
export const revokeMine = authedMutation({
  args: {},
  handler: async (ctx) => revokeRows(ctx, await rowsForUser(ctx, ctx.identity.tokenIdentifier), Date.now()),
})

/**
 * Retention. One row per minted token, two per login and two more per refresh,
 * is unbounded growth at Cloud scale.
 *
 * Deleting an expired row can never resurrect a credential: an expired JWT
 * fails `jwtVerify` before the registry is consulted, and an unknown `jti`
 * rejects anyway. `retain_ms` is a clock-skew cushion, not a safety property.
 * Bounded per tick so one sweep stays inside a single Convex transaction; a
 * backlog drains over the following ticks.
 */
export const reapExpired = cronMutation({
  args: {
    retain_ms: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.retain_ms
    const rows = (await ctx.db
      .query("cli_session_tokens")
      .withIndex("by_expires_at", (q: any) => q.lte("expires_at", cutoff))
      .take(args.limit)) as Row[]
    for (const row of rows) await ctx.db.delete(row._id)
    return { deleted: rows.length }
  },
})
