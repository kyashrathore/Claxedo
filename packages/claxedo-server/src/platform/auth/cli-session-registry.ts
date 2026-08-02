/**
 * Revocation registry for CLI session tokens (`claxedo login` credentials).
 *
 * CLI session tokens are the longest-lived bearer credential Claxedo issues:
 * they sit in a file on a developer's laptop and authenticate every subsequent
 * control-plane call. A signature check alone can only answer "was this minted
 * by us and has it expired yet" — it can never answer "is this still allowed",
 * so a leaked credential stays valid for its whole TTL with no way to pull it.
 *
 * This module is the port that closes that hole, mirroring the mechanism the
 * Runtime Access Token path already uses: every mint writes a `jti` row, every
 * verification looks the `jti` up, and revocation flips the row. Verification
 * FAILS CLOSED — a `jti` that is absent, revoked, expired, or bound to a
 * different user is rejected, and so is a token presented when no registry is
 * reachable at all. "We could not check" is never "allow".
 *
 * Storage lives behind the port on purpose. This file names no backend: the
 * control-plane core stays storage-agnostic and the composition root decides
 * (durable table in the hosted deployment, in-memory for a single-process
 * self-host box or a test).
 */

/** Access tokens authenticate API calls; refresh tokens only mint new pairs. */
export type CliSessionTokenKind = "access" | "refresh"

export type CliSessionTokenRecord = {
  /** JWT `jti` claim — the registry's primary key. */
  jti: string
  kind: CliSessionTokenKind
  /**
   * Stable per-user identity (`token_identifier`) the token was minted for.
   * This is the revoke-all key: "sign me out of every CLI everywhere".
   */
  tokenIdentifier: string
  /** JWT `sub` of the human the token acts as. */
  subject: string
  /** Absolute expiry of THIS token, epoch ms. */
  expiresAt: number
  /**
   * Login-chain identity. Every access/refresh pair descended from one
   * `claxedo login` shares it, so a chain can be revoked as a unit.
   */
  sessionId: string
  /**
   * Absolute expiry of the whole login chain, epoch ms. Refresh rotation may
   * never push a token past this, so a continuously-refreshed CLI still has to
   * re-authenticate eventually instead of living forever.
   */
  sessionExpiresAt: number
}

export type CliSessionTokenInactiveCode =
  | "cli_session_token_unknown"
  | "cli_session_token_revoked"
  | "cli_session_token_expired"
  | "cli_session_token_mismatch"

export type CliSessionTokenStatus =
  | { active: true; record: CliSessionTokenRecord }
  | { active: false; code: CliSessionTokenInactiveCode; reason: string }

export type CliSessionRotationResult =
  | { ok: true }
  | { ok: false; code: CliSessionTokenInactiveCode; reason: string }

/**
 * The registry contract. Implementations MUST be durable and shared by every
 * process that verifies CLI bearers — a per-process cache would let a token
 * minted by one instance read as `unknown` on another, and a revocation
 * written on one instance would not be seen by the rest.
 */
export type CliSessionTokenRegistry = {
  /** Called once per minted token, BEFORE the token is handed to the caller. */
  recordMint(record: CliSessionTokenRecord): Promise<{ ok: true }>
  /**
   * Refresh rotation, as ONE indivisible step: burn the presented token and
   * register its replacements together, or change nothing.
   *
   * Deliberately not expressible as `recordMint` + `revoke`. Between those two
   * calls the spent refresh token and its replacement are both live — a replay
   * window — and a crash in the gap leaves the old token valid for its whole
   * remaining TTL with the new one already handed out. Implementations MUST
   * re-validate `previous` as part of the same atomic step rather than trusting
   * the caller's earlier `active` check, so that two concurrent refreshes of
   * one token cannot both succeed and fork the chain.
   *
   * A rejection means nothing was written: the caller must discard the tokens
   * it signed, which are unregistered and therefore unusable.
   */
  rotate(args: {
    previous: { jti: string; tokenIdentifier: string }
    minted: CliSessionTokenRecord[]
  }): Promise<CliSessionRotationResult>
  /** Verification-time lookup. Anything other than `active: true` rejects. */
  active(args: {
    jti: string
    kind: CliSessionTokenKind
    tokenIdentifier: string
  }): Promise<CliSessionTokenStatus>
  /** Revoke one token by `jti`, scoped to its owner so ids cannot be guessed across users. */
  revoke(args: { jti: string; tokenIdentifier: string }): Promise<{ revoked: number }>
  /** Revoke every token in one login chain (used by refresh rotation and logout). */
  revokeSession(args: { sessionId: string; tokenIdentifier: string }): Promise<{ revoked: number }>
  /** Revoke every token a user holds — the "lost my laptop" button. */
  revokeForUser(args: { tokenIdentifier: string }): Promise<{ revoked: number }>
}

export class CliSessionRegistryUnavailableError extends Error {
  readonly code = "cli_session_registry_unavailable"
  constructor(
    message = "CLI session token registry is not configured; CLI tokens cannot be minted or verified",
  ) {
    super(message)
  }
}

/**
 * In-memory registry.
 *
 * Correct ONLY where a single process both mints and verifies (a self-host box,
 * a test). It is deliberately not the default: silently defaulting to it in a
 * multi-instance deployment would make every token minted elsewhere read as
 * `unknown`, and every revocation invisible to the other instances.
 */
export function createInMemoryCliSessionTokenRegistry(): CliSessionTokenRegistry & {
  /** Test/diagnostic view. Not part of the port. */
  rows(): (CliSessionTokenRecord & { revokedAt?: number })[]
} {
  const rows = new Map<string, CliSessionTokenRecord & { revokedAt?: number }>()

  const revokeMatching = (match: (row: CliSessionTokenRecord) => boolean) => {
    const now = Date.now()
    let revoked = 0
    for (const row of rows.values()) {
      if (row.revokedAt || !match(row)) continue
      row.revokedAt = now
      revoked += 1
    }
    return { revoked }
  }

  const evaluate = (
    row: (CliSessionTokenRecord & { revokedAt?: number }) | undefined,
    args: { kind: CliSessionTokenKind; tokenIdentifier: string },
  ): CliSessionTokenStatus => {
    if (!row) {
      return {
        active: false,
        code: "cli_session_token_unknown",
        reason: "CLI session token has not been recorded",
      }
    }
    if (row.revokedAt) {
      return {
        active: false,
        code: "cli_session_token_revoked",
        reason: "CLI session token has been revoked",
      }
    }
    if (row.kind !== args.kind || row.tokenIdentifier !== args.tokenIdentifier) {
      return {
        active: false,
        code: "cli_session_token_mismatch",
        reason: "CLI session token does not match its recorded kind or owner",
      }
    }
    const now = Date.now()
    if (row.expiresAt <= now || row.sessionExpiresAt <= now) {
      return {
        active: false,
        code: "cli_session_token_expired",
        reason: "CLI session token has expired",
      }
    }
    const { revokedAt: _revokedAt, ...record } = row
    return { active: true, record }
  }

  return {
    async recordMint(record) {
      if (rows.has(record.jti)) throw new Error("CLI session token already recorded")
      rows.set(record.jti, { ...record })
      return { ok: true }
    },
    // Atomic by construction rather than by transaction: this whole body runs
    // between awaits, so no other caller observes the intermediate state.
    async rotate(args) {
      const previous = rows.get(args.previous.jti)
      const status = evaluate(previous, { kind: "refresh", tokenIdentifier: args.previous.tokenIdentifier })
      if (!status.active) return { ok: false, code: status.code, reason: status.reason }
      const foreign = args.minted.find((record) => record.tokenIdentifier !== args.previous.tokenIdentifier)
      if (foreign) {
        return {
          ok: false,
          code: "cli_session_token_mismatch",
          reason: "Rotated CLI session tokens must belong to the presented token's owner",
        }
      }
      if (args.minted.some((record) => rows.has(record.jti))) {
        throw new Error("CLI session token already recorded")
      }
      previous!.revokedAt = Date.now()
      for (const record of args.minted) rows.set(record.jti, { ...record })
      return { ok: true }
    },
    async active(args) {
      return evaluate(rows.get(args.jti), args)
    },
    async revoke(args) {
      return revokeMatching((row) => row.jti === args.jti && row.tokenIdentifier === args.tokenIdentifier)
    },
    async revokeSession(args) {
      return revokeMatching(
        (row) => row.sessionId === args.sessionId && row.tokenIdentifier === args.tokenIdentifier,
      )
    },
    async revokeForUser(args) {
      return revokeMatching((row) => row.tokenIdentifier === args.tokenIdentifier)
    },
    rows() {
      return [...rows.values()].map((row) => ({ ...row }))
    },
  }
}

/**
 * The slice of the workspace authority this registry needs.
 *
 * Declared structurally rather than importing the full authority type so the
 * port stays independent of the authority's shape — and so the storage adapters
 * have one fixed target to implement against. Argument names are snake_case to
 * match the authority's wire contract for token rows.
 */
export type CliSessionTokenAuthority = {
  recordCliSessionToken(args: {
    jti: string
    kind: CliSessionTokenKind
    token_identifier: string
    subject: string
    session_id: string
    expires_at: number
    session_expires_at: number
  }): Promise<unknown>
  rotateCliSessionTokens(args: {
    previous_jti: string
    token_identifier: string
    minted: {
      jti: string
      kind: CliSessionTokenKind
      token_identifier: string
      subject: string
      session_id: string
      expires_at: number
      session_expires_at: number
    }[]
  }): Promise<unknown>
  cliSessionTokenActive(args: {
    jti: string
    kind: CliSessionTokenKind
    token_identifier: string
  }): Promise<unknown>
  revokeCliSessionToken(args: { jti: string; token_identifier: string }): Promise<unknown>
  revokeCliSessionChain(args: { session_id: string; token_identifier: string }): Promise<unknown>
  revokeCliSessionTokensForUser(args: { token_identifier: string }): Promise<unknown>
}

function revokedCount(result: unknown) {
  const value = (result as { revoked?: unknown } | undefined)?.revoked
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function inactive(code: CliSessionTokenInactiveCode, reason: string): CliSessionTokenStatus {
  return { active: false, code, reason }
}

/**
 * Adapt the durable workspace authority to the registry port.
 *
 * Anything the authority returns that is not an unambiguous `active: true` with
 * a well-formed record is treated as a rejection — a malformed or partial
 * response must never read as "allowed".
 */
export function authorityCliSessionTokenRegistry(
  authority: CliSessionTokenAuthority,
): CliSessionTokenRegistry {
  const wire = (record: CliSessionTokenRecord) => ({
    jti: record.jti,
    kind: record.kind,
    token_identifier: record.tokenIdentifier,
    subject: record.subject,
    session_id: record.sessionId,
    expires_at: record.expiresAt,
    session_expires_at: record.sessionExpiresAt,
  })
  return {
    async recordMint(record) {
      await authority.recordCliSessionToken(wire(record))
      return { ok: true }
    },
    async rotate(args) {
      const result = (await authority.rotateCliSessionTokens({
        previous_jti: args.previous.jti,
        token_identifier: args.previous.tokenIdentifier,
        minted: args.minted.map(wire),
      })) as { ok?: unknown; code?: unknown; reason?: unknown } | undefined
      // Same posture as `active`: only an unambiguous `ok: true` counts. A
      // malformed or partial answer means we do not know whether the burn
      // landed, and the caller must throw the signed tokens away.
      if (result?.ok === true) return { ok: true }
      return {
        ok: false,
        code:
          typeof result?.code === "string"
            ? (result.code as CliSessionTokenInactiveCode)
            : "cli_session_token_unknown",
        reason: typeof result?.reason === "string" ? result.reason : "CLI session token could not be rotated",
      }
    },
    async active(args) {
      const result = (await authority.cliSessionTokenActive({
        jti: args.jti,
        kind: args.kind,
        token_identifier: args.tokenIdentifier,
      })) as
        | { active?: unknown; code?: unknown; reason?: unknown; record?: Partial<CliSessionTokenRecord> }
        | undefined
      if (result?.active !== true) {
        const code = typeof result?.code === "string" ? (result.code as CliSessionTokenInactiveCode) : undefined
        return inactive(
          code ?? "cli_session_token_unknown",
          typeof result?.reason === "string" ? result.reason : "CLI session token is not active",
        )
      }
      const record = result.record
      if (
        record?.jti !== args.jti ||
        record.kind !== args.kind ||
        record.tokenIdentifier !== args.tokenIdentifier ||
        typeof record.sessionId !== "string" ||
        !record.sessionId.trim() ||
        typeof record.expiresAt !== "number" ||
        !Number.isFinite(record.expiresAt) ||
        typeof record.sessionExpiresAt !== "number" ||
        !Number.isFinite(record.sessionExpiresAt)
      ) {
        return inactive(
          "cli_session_token_mismatch",
          "CLI session token registry returned an invalid or mismatched record",
        )
      }
      if (record.expiresAt <= Date.now() || record.sessionExpiresAt <= Date.now()) {
        return inactive("cli_session_token_expired", "CLI session token has expired")
      }
      return {
        active: true,
        record: {
          jti: record.jti,
          kind: record.kind,
          tokenIdentifier: record.tokenIdentifier,
          subject: record.subject ?? record.tokenIdentifier,
          sessionId: record.sessionId,
          expiresAt: record.expiresAt,
          sessionExpiresAt: record.sessionExpiresAt,
        },
      }
    },
    async revoke(args) {
      return {
        revoked: revokedCount(
          await authority.revokeCliSessionToken({
            jti: args.jti,
            token_identifier: args.tokenIdentifier,
          }),
        ),
      }
    },
    async revokeSession(args) {
      return {
        revoked: revokedCount(
          await authority.revokeCliSessionChain({
            session_id: args.sessionId,
            token_identifier: args.tokenIdentifier,
          }),
        ),
      }
    },
    async revokeForUser(args) {
      return {
        revoked: revokedCount(
          await authority.revokeCliSessionTokensForUser({ token_identifier: args.tokenIdentifier }),
        ),
      }
    },
  }
}

let configured: CliSessionTokenRegistry | undefined

/**
 * Composition-root seam, matching the `configureX(...)` idiom the rest of the
 * server uses. Call once at startup with the deployment's durable registry.
 * Passing `undefined` clears it, which puts the CLI token path back to
 * fail-closed.
 */
export function configureCliSessionTokenRegistry(registry: CliSessionTokenRegistry | undefined) {
  configured = registry
}

/**
 * Resolve the registry to use for one operation: an explicitly injected one
 * wins, otherwise the configured process-wide one. Throws when neither exists
 * — minting an unrevokable credential, or accepting a credential we cannot
 * check, are both worse than an outage.
 */
export function resolveCliSessionTokenRegistry(
  explicit?: CliSessionTokenRegistry,
): CliSessionTokenRegistry {
  const registry = explicit ?? configured
  if (!registry) throw new CliSessionRegistryUnavailableError()
  return registry
}
