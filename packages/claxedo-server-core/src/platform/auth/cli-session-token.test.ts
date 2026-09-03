/**
 * CLI session tokens are the revocable credential `claxedo login` leaves on a
 * developer's disk. These invariants define their security boundary:
 *
 *   1. every minted token carries a `jti` AND is recorded, so it can be named;
 *   2. verification consults the registry and FAILS CLOSED — unknown, revoked,
 *      expired, wrong-owner, or "no registry at all" are all rejections;
 *   3. revocation works both per-token and per-user;
 *   4. refresh rotates: the presented refresh token is burned, so a captured
 *      copy is single-use and a replay reads as revoked;
 *   5. the login chain has an absolute lifetime that rotation cannot extend;
 *   6. a TTL outside the signer's bounds is refused at mint time rather than
 *      silently clamped, so a misconfigured deployment fails at first login.
 *
 * Tripwire: delete the `registry.active(...)` call in `verifyCliToken` and
 * cases (2)–(4) go green-on-nothing — they are the reason this file exists.
 */
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  CLI_ACCESS_TOKEN_TTL_BOUNDS_SECONDS,
  CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS,
  CLI_SESSION_MAX_LIFETIME_SECONDS,
  mintCliSessionTokens,
  refreshCliSessionTokens,
  revokeCliSessionChain,
  revokeCliSessionToken,
  revokeCliSessionTokensForUser,
  verifyCliAccessBearer,
} from "./cli-session-token"
import {
  authorityCliSessionTokenRegistry,
  configureCliSessionTokenRegistry,
  createInMemoryCliSessionTokenRegistry,
  type CliSessionTokenAuthority,
  type CliSessionTokenRegistry,
} from "./cli-session-registry"
import type { SignedControlPlaneAuth } from "./auth"

const REFRESH_PREFIX = "claxedo_cli_refresh:"

type Env = Record<string, string | undefined>

let env: Env
let registry: ReturnType<typeof createInMemoryCliSessionTokenRegistry>

function auth(subject = "user_1"): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: "provider-token",
    user: {
      subject,
      tokenIdentifier: `https://issuer.test|${subject}`,
      issuer: "https://issuer.test",
    },
  }
}

async function keyEnv(): Promise<Env> {
  const pair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_CLI_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(pair.privateKey),
    CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(pair.publicKey),
    CLAXEDO_CLI_TOKEN_ALGORITHM: "EdDSA",
    CLAXEDO_CLI_TOKEN_ISSUER: "https://control-plane.test",
  }
}

/** Mint against the suite's registry unless a test wants a different one. */
function mint(who = auth(), options: { registry?: CliSessionTokenRegistry } = {}) {
  return mintCliSessionTokens(who, env, { registry: options.registry ?? registry })
}

beforeEach(async () => {
  env = await keyEnv()
  registry = createInMemoryCliSessionTokenRegistry()
  // The module-wide seam must stay unset: every test injects explicitly, and
  // the "no registry configured" cases below depend on it being absent.
  configureCliSessionTokenRegistry(undefined)
})

describe("minted CLI session tokens are nameable", () => {
  test("access and refresh tokens each carry a jti", async () => {
    const minted = await mint()

    const access = decodeJwt(minted.access_token)
    const refresh = decodeJwt(minted.refresh_token.slice(REFRESH_PREFIX.length))

    expect(typeof access.jti).toBe("string")
    expect(access.jti).toBeTruthy()
    expect(typeof refresh.jti).toBe("string")
    expect(refresh.jti).toBeTruthy()
    expect(access.jti).not.toBe(refresh.jti)
  })

  test("both tokens are recorded in the registry under the minting user", async () => {
    const minted = await mint()
    const access = decodeJwt(minted.access_token)
    const refresh = decodeJwt(minted.refresh_token.slice(REFRESH_PREFIX.length))

    const rows = registry.rows()
    expect(rows.map((row) => row.jti).sort()).toEqual([access.jti, refresh.jti].sort())
    expect(rows.map((row) => row.kind).sort()).toEqual(["access", "refresh"])
    for (const row of rows) {
      expect(row.tokenIdentifier).toBe("https://issuer.test|user_1")
      expect(row.revokedAt).toBeUndefined()
    }
    // One login, one chain.
    expect(new Set(rows.map((row) => row.sessionId)).size).toBe(1)
  })

  test("positive control: a fresh, unrevoked token verifies", async () => {
    const minted = await mint()

    const verified = await verifyCliAccessBearer(minted.access_token, env, { registry })

    expect(verified).toMatchObject({
      mode: "signed",
      tokenKind: "cli",
      user: { subject: "user_1", tokenIdentifier: "https://issuer.test|user_1" },
    })
  })
})

describe("verification fails closed", () => {
  test("a token whose jti is not in the registry is rejected", async () => {
    // Signature-valid, issuer-valid, unexpired — and unknown. Before the
    // registry check this token sailed through.
    const minted = await mint()
    const empty = createInMemoryCliSessionTokenRegistry()

    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: empty })).rejects.toThrow(
      /has not been recorded/i,
    )
  })

  test("a refresh token replayed on the access path is rejected", async () => {
    const minted = await mint()
    const raw = minted.refresh_token.slice(REFRESH_PREFIX.length)

    await expect(verifyCliAccessBearer(raw, env, { registry })).rejects.toThrow()
  })

  test("no configured registry means no mint and no verify", async () => {
    // Fail-closed at BOTH ends: a deployment that cannot record a token must
    // not issue one, and a deployment that cannot check a token must not
    // accept one.
    await expect(mintCliSessionTokens(auth(), env)).rejects.toThrow(/registry is not configured/i)

    const minted = await mint()
    await expect(verifyCliAccessBearer(minted.access_token, env)).rejects.toThrow(
      /registry is not configured/i,
    )
  })

  test("a token recorded for another user is rejected", async () => {
    const minted = await mint(auth("user_1"))
    const access = decodeJwt(minted.access_token)
    // Simulate a registry row that disagrees with the token about its owner.
    const mismatched: CliSessionTokenRegistry = {
      ...registry,
      async active() {
        return {
          active: false,
          code: "cli_session_token_mismatch",
          reason: "CLI session token does not match its recorded kind or owner",
        }
      },
    }
    expect(access.jti).toBeTruthy()

    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: mismatched })).rejects.toThrow(
      /does not match/i,
    )
  })
})

describe("revocation", () => {
  test("a revoked token is rejected on the next verification", async () => {
    const minted = await mint()
    const jti = decodeJwt(minted.access_token).jti as string

    // Valid right up to the moment it is revoked.
    await expect(verifyCliAccessBearer(minted.access_token, env, { registry })).resolves.toBeTruthy()

    const revoked = await revokeCliSessionToken(
      { jti, tokenIdentifier: "https://issuer.test|user_1" },
      { registry },
    )
    expect(revoked).toEqual({ revoked: 1 })

    await expect(verifyCliAccessBearer(minted.access_token, env, { registry })).rejects.toThrow(
      /has been revoked/i,
    )
  })

  test("revoking by jti does not touch another user's token", async () => {
    const mine = await mint(auth("user_1"))
    const theirs = await mint(auth("user_2"))
    const theirJti = decodeJwt(theirs.access_token).jti as string

    // Naming someone else's jti under my identity must be a no-op.
    expect(
      await revokeCliSessionToken(
        { jti: theirJti, tokenIdentifier: "https://issuer.test|user_1" },
        { registry },
      ),
    ).toEqual({ revoked: 0 })

    await expect(verifyCliAccessBearer(theirs.access_token, env, { registry })).resolves.toBeTruthy()
    await expect(verifyCliAccessBearer(mine.access_token, env, { registry })).resolves.toBeTruthy()
  })

  test("revoke-all rejects every token that user holds, across devices", async () => {
    const laptop = await mint(auth("user_1"))
    const desktop = await mint(auth("user_1"))
    const other = await mint(auth("user_2"))

    // 2 logins x (access + refresh)
    expect(await revokeCliSessionTokensForUser(
      { tokenIdentifier: "https://issuer.test|user_1" },
      { registry },
    )).toEqual({ revoked: 4 })

    await expect(verifyCliAccessBearer(laptop.access_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(verifyCliAccessBearer(desktop.access_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(refreshCliSessionTokens(laptop.refresh_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(refreshCliSessionTokens(desktop.refresh_token, env, { registry })).rejects.toThrow(/revoked/i)

    // Blast radius stops at the user boundary.
    await expect(verifyCliAccessBearer(other.access_token, env, { registry })).resolves.toBeTruthy()
  })

  test("revoking a login chain kills that device's access and refresh together", async () => {
    const laptop = await mint(auth("user_1"))
    const desktop = await mint(auth("user_1"))
    const sessionId = registry.rows().find((row) => row.jti === decodeJwt(laptop.access_token).jti)!.sessionId

    expect(await revokeCliSessionChain(
      { sessionId, tokenIdentifier: "https://issuer.test|user_1" },
      { registry },
    )).toEqual({ revoked: 2 })

    await expect(verifyCliAccessBearer(laptop.access_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(refreshCliSessionTokens(laptop.refresh_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(verifyCliAccessBearer(desktop.access_token, env, { registry })).resolves.toBeTruthy()
  })
})

describe("refresh rotation", () => {
  test("refresh mints a new pair and burns the presented refresh token", async () => {
    const first = await mint()

    const second = await refreshCliSessionTokens(first.refresh_token, env, { registry })
    expect(second.access_token).not.toBe(first.access_token)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    await expect(verifyCliAccessBearer(second.access_token, env, { registry })).resolves.toBeTruthy()

    // Single use: replaying the spent refresh token is a revoked token.
    await expect(refreshCliSessionTokens(first.refresh_token, env, { registry })).rejects.toThrow(/revoked/i)
  })

  test("rotation stays inside the original login chain", async () => {
    const first = await mint()
    const second = await refreshCliSessionTokens(first.refresh_token, env, { registry })

    const before = decodeJwt(first.access_token)
    const after = decodeJwt(second.access_token)
    expect(after.claxedo_cli_session_id).toBe(before.claxedo_cli_session_id)
    // The absolute expiry is carried through, never pushed forward.
    expect(after.claxedo_cli_session_exp).toBe(before.claxedo_cli_session_exp)
  })

  test("the login chain has a bounded absolute lifetime", async () => {
    const minted = await mint()
    const claims = decodeJwt(minted.access_token)
    const sessionExp = claims.claxedo_cli_session_exp as number

    expect(sessionExp - (claims.iat as number)).toBeLessThanOrEqual(CLI_SESSION_MAX_LIFETIME_SECONDS)
    expect(minted.session_expires_in).toBeLessThanOrEqual(CLI_SESSION_MAX_LIFETIME_SECONDS)
    expect(CLI_SESSION_MAX_LIFETIME_SECONDS).toBe(90 * 24 * 60 * 60)
  })

  test("an explicit continuation expiry cannot extend the maximum lifetime", async () => {
    const minted = await mintCliSessionTokens(auth(), env, {
      registry,
      sessionExpiresAt: Date.now() + 2 * CLI_SESSION_MAX_LIFETIME_SECONDS * 1_000,
    })
    const claims = decodeJwt(minted.access_token)

    expect((claims.claxedo_cli_session_exp as number) - (claims.iat as number))
      .toBeLessThanOrEqual(CLI_SESSION_MAX_LIFETIME_SECONDS)
  })

  test("rotation cannot push a token past the chain's absolute expiry", async () => {
    // A login two hours from its hard deadline. The default refresh TTL is
    // fourteen days; if rotation ignored the cap, the new token would outlive
    // the login by a fortnight and the chain bound would be decorative.
    const ending = createInMemoryCliSessionTokenRegistry()
    const first = await mintCliSessionTokens(auth(), env, {
      registry: ending,
      sessionExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
    })
    expect(first.refresh_expires_in).toBeLessThanOrEqual(2 * 60 * 60)

    const second = await refreshCliSessionTokens(first.refresh_token, env, { registry: ending })
    expect(second.refresh_expires_in).toBeLessThanOrEqual(2 * 60 * 60)
    expect(second.session_expires_in).toBeLessThanOrEqual(2 * 60 * 60)
    expect(decodeJwt(second.access_token).claxedo_cli_session_exp).toBe(
      decodeJwt(first.access_token).claxedo_cli_session_exp,
    )
  })

  test("an exhausted login chain stops verifying and cannot be rotated", async () => {
    vi.useFakeTimers()
    try {
      const expiring = createInMemoryCliSessionTokenRegistry()
      const minted = await mintCliSessionTokens(auth(), env, {
        registry: expiring,
        sessionExpiresAt: Date.now() + 1_000,
      })
      vi.advanceTimersByTime(1_100)

      await expect(verifyCliAccessBearer(minted.access_token, env, { registry: expiring })).rejects.toThrow()
      await expect(refreshCliSessionTokens(minted.refresh_token, env, { registry: expiring })).rejects.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("TTL bounds", () => {
  test("bounds keep access and refresh credentials short-lived", () => {
    expect(CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS.max).toBe(30 * 24 * 60 * 60)
    expect(CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS.max).toBeLessThan(10 * 365 * 24 * 60 * 60)
    expect(CLI_ACCESS_TOKEN_TTL_BOUNDS_SECONDS.max).toBe(12 * 60 * 60)
  })

  test("defaults land inside the bounds", async () => {
    const minted = await mint()
    expect(minted.expires_in).toBe(60 * 60)
    expect(minted.refresh_expires_in).toBe(14 * 24 * 60 * 60)
  })

  test("a refresh TTL above the cap is refused at mint time", async () => {
    const over = {
      ...env,
      CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS: String(CLI_REFRESH_TOKEN_TTL_BOUNDS_SECONDS.max + 1),
    }

    await expect(mintCliSessionTokens(auth(), over, { registry })).rejects.toThrow(
      /CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS must be between/,
    )
    // Refused, not silently clamped: nothing was issued.
    expect(registry.rows()).toEqual([])
  })

  test("an access TTL above the cap is refused at mint time", async () => {
    const over = {
      ...env,
      CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: String(CLI_ACCESS_TOKEN_TTL_BOUNDS_SECONDS.max + 1),
    }

    await expect(mintCliSessionTokens(auth(), over, { registry })).rejects.toThrow(
      /CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS must be between/,
    )
  })

  test("the old ten-year TTL is no longer accepted", async () => {
    const legacy = { ...env, CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS: String(10 * 365 * 24 * 60 * 60) }

    await expect(mintCliSessionTokens(auth(), legacy, { registry })).rejects.toThrow(/must be between/)
  })

  test("an in-bounds TTL is honored", async () => {
    const tuned = {
      ...env,
      CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: "600",
      CLAXEDO_CLI_REFRESH_TOKEN_TTL_SECONDS: String(7 * 24 * 60 * 60),
    }

    const minted = await mintCliSessionTokens(auth(), tuned, { registry })
    expect(minted.expires_in).toBe(600)
    expect(minted.refresh_expires_in).toBe(7 * 24 * 60 * 60)
  })
})

describe("authority-backed registry adapter", () => {
  /** Stands in for the durable authority the hosted deployment will pass. */
  function fakeAuthority(overrides: Partial<CliSessionTokenAuthority> = {}) {
    const rows = new Map<string, Record<string, unknown> & { revoked_at?: number }>()
    return {
      rows,
      authority: {
        async recordCliSessionToken(args) {
          rows.set(args.jti, { ...args })
          return { ok: true }
        },
        async cliSessionTokenActive(args) {
          const row = rows.get(args.jti)
          if (!row) return { active: false, code: "cli_session_token_unknown", reason: "not recorded" }
          if (row.revoked_at) return { active: false, code: "cli_session_token_revoked", reason: "revoked" }
          return {
            active: true,
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
        },
        // Mirrors the durable `cliSessionTokens.rotate` mutation: re-validate
        // the presented token and, only then, burn it and register the
        // replacements — as one step, never as mint-then-revoke.
        async rotateCliSessionTokens(args) {
          const previous = rows.get(args.previous_jti)
          if (!previous || previous.token_identifier !== args.token_identifier) {
            return { ok: false, code: "cli_session_token_unknown", reason: "not recorded" }
          }
          if (previous.revoked_at) return { ok: false, code: "cli_session_token_revoked", reason: "revoked" }
          previous.revoked_at = Date.now()
          for (const record of args.minted) rows.set(record.jti, { ...record })
          return { ok: true }
        },
        async revokeCliSessionToken(args) {
          const row = rows.get(args.jti)
          if (!row || row.token_identifier !== args.token_identifier) return { revoked: 0 }
          row.revoked_at = Date.now()
          return { revoked: 1 }
        },
        async revokeCliSessionChain() {
          return { revoked: 0 }
        },
        async revokeCliSessionTokensForUser(args) {
          let revoked = 0
          for (const row of rows.values()) {
            if (row.revoked_at || row.token_identifier !== args.token_identifier) continue
            row.revoked_at = Date.now()
            revoked += 1
          }
          return { revoked }
        },
        ...overrides,
      } satisfies CliSessionTokenAuthority,
    }
  }

  test("mints, verifies, and revokes through the authority", async () => {
    const { authority } = fakeAuthority()
    const backed = authorityCliSessionTokenRegistry(authority)

    const minted = await mintCliSessionTokens(auth(), env, { registry: backed })
    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: backed })).resolves.toBeTruthy()

    expect(await revokeCliSessionTokensForUser(
      { tokenIdentifier: "https://issuer.test|user_1" },
      { registry: backed },
    )).toEqual({ revoked: 2 })
    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: backed })).rejects.toThrow(
      /revoked/i,
    )
  })

  test("an incomplete authority response is a rejection, not an accept", async () => {
    // A backend that answers `{active: true}` with no record must not be read
    // as permission — "shaped like a yes" is not a yes.
    const { authority } = fakeAuthority({
      async cliSessionTokenActive() {
        return { active: true }
      },
    })
    const backed = authorityCliSessionTokenRegistry(authority)
    const minted = await mintCliSessionTokens(auth(), env, { registry: backed })

    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: backed })).rejects.toThrow(
      /invalid or mismatched record/i,
    )
  })

  test("an active authority record must exactly match the requested token", async () => {
    const requested = {
      jti: "expected-jti",
      kind: "access" as const,
      tokenIdentifier: "https://issuer.test|user_1",
    }
    const record = {
      ...requested,
      subject: "user_1",
      sessionId: "session_1",
      expiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 600_000,
    }
    const mismatches = [
      { name: "jti", patch: { jti: "other-jti" } },
      { name: "kind", patch: { kind: "refresh" } },
      { name: "missing kind", patch: { kind: undefined } },
      { name: "owner", patch: { tokenIdentifier: "https://issuer.test|user_2" } },
    ]

    for (const mismatch of mismatches) {
      const { authority } = fakeAuthority({
        async cliSessionTokenActive() {
          return { active: true, record: { ...record, ...mismatch.patch } }
        },
      })

      await expect(
        authorityCliSessionTokenRegistry(authority).active(requested),
        mismatch.name,
      ).resolves.toMatchObject({
        active: false,
        code: "cli_session_token_mismatch",
      })
    }
  })

  test("an active authority record must have finite, unexpired token and session expiries", async () => {
    const requested = {
      jti: "expected-jti",
      kind: "access" as const,
      tokenIdentifier: "https://issuer.test|user_1",
    }
    const record = {
      ...requested,
      subject: "user_1",
      sessionId: "session_1",
      expiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 600_000,
    }
    const invalid = [
      { name: "non-finite token expiry", patch: { expiresAt: Number.NaN }, code: "cli_session_token_mismatch" },
      {
        name: "non-finite session expiry",
        patch: { sessionExpiresAt: Number.POSITIVE_INFINITY },
        code: "cli_session_token_mismatch",
      },
      { name: "expired token", patch: { expiresAt: Date.now() - 1 }, code: "cli_session_token_expired" },
      {
        name: "expired session",
        patch: { sessionExpiresAt: Date.now() - 1 },
        code: "cli_session_token_expired",
      },
    ]

    for (const item of invalid) {
      const { authority } = fakeAuthority({
        async cliSessionTokenActive() {
          return { active: true, record: { ...record, ...item.patch } }
        },
      })

      await expect(
        authorityCliSessionTokenRegistry(authority).active(requested),
        item.name,
      ).resolves.toMatchObject({
        active: false,
        code: item.code,
      })
    }
  })

  test("an authority outage rejects rather than admits", async () => {
    const { authority } = fakeAuthority({
      async cliSessionTokenActive() {
        throw new Error("authority unreachable")
      },
    })
    const backed = authorityCliSessionTokenRegistry(authority)
    const minted = await mintCliSessionTokens(auth(), env, { registry: backed })

    await expect(verifyCliAccessBearer(minted.access_token, env, { registry: backed })).rejects.toThrow(
      /unreachable/i,
    )
  })
})

describe("configured registry seam", () => {
  test("the process-wide registry is used when no explicit one is passed", async () => {
    configureCliSessionTokenRegistry(registry)
    try {
      const minted = await mintCliSessionTokens(auth(), env)
      await expect(verifyCliAccessBearer(minted.access_token, env)).resolves.toBeTruthy()

      await revokeCliSessionTokensForUser({ tokenIdentifier: "https://issuer.test|user_1" })
      await expect(verifyCliAccessBearer(minted.access_token, env)).rejects.toThrow(/revoked/i)
    } finally {
      configureCliSessionTokenRegistry(undefined)
    }
  })
})
