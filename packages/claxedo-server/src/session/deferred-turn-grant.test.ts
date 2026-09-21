import { describe, expect, test } from "vitest"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import {
  childCompletionTurnIdPrefix,
  SessionTurnGrantError,
  type SessionTurnGrant,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import {
  DEFERRED_TURN_GRANT_AUDIENCE,
  DEFERRED_TURN_GRANT_ISSUER,
  DeferredTurnGrantConfigurationError,
  deferredTurnGrantClaims,
  mintDeferredTurnGrant,
  verifyDeferredTurnGrant,
} from "./deferred-turn-grant"

const principal = { principalKind: "user" as const, actorId: "actor_alice", actorKind: "human" as const }
const issuedAt = 1_700_000_000_000
const expiresAt = issuedAt + 24 * 60 * 60_000

const wakeRow: SessionTurnGrant = {
  grantId: "grant_wake_1",
  sessionId: "ses_parent",
  workspaceId: "ws_1",
  actorId: "actor_alice",
  intent: "child_completion",
  subjectSessionId: "ses_child",
  turnIdPrefix: childCompletionTurnIdPrefix("ses_child"),
  issuedAt,
  expiresAt,
}

const queuedRow: SessionTurnGrant = {
  grantId: "grant_queued_1",
  sessionId: "ses_parent",
  workspaceId: "ws_1",
  actorId: "actor_alice",
  intent: "queued_prompt",
  turnId: "msg_queued_1",
  issuedAt,
  expiresAt,
}

async function keys() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    signingKey: key.privateKey,
    env: {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    },
  }
}

const now = () => issuedAt + 60_000

async function code(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    if (error instanceof SessionTurnGrantError) return error.code
    throw error
  }
  return undefined
}

describe("deferred turn grant", () => {
  test("a child-completion grant carries exactly the plan's claims and verifies back to them", async () => {
    const { env } = await keys()
    const claims = deferredTurnGrantClaims(principal, "org_1", wakeRow)
    const minted = await mintDeferredTurnGrant(claims, env, { now })

    expect(minted.expiresAt).toBe(Math.floor(expiresAt / 1_000) * 1_000)
    expect(decodeJwt(minted.grant)).toEqual({
      iss: DEFERRED_TURN_GRANT_ISSUER,
      aud: DEFERRED_TURN_GRANT_AUDIENCE,
      jti: "grant_wake_1",
      principal_kind: "user",
      actor_id: "actor_alice",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      session_id: "ses_parent",
      intent: "child_completion",
      subject_session_id: "ses_child",
      turn_id_prefix: "msg_wake_ses_child_",
      iat: Math.floor(now() / 1_000),
      exp: Math.floor(expiresAt / 1_000),
    })
    await expect(verifyDeferredTurnGrant(minted.grant, env, { sessionId: "ses_parent", now })).resolves.toEqual({
      ...principal,
      grantId: "grant_wake_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      sessionId: "ses_parent",
      intent: "child_completion",
      subjectSessionId: "ses_child",
      turnIdPrefix: "msg_wake_ses_child_",
      issuedAt: Math.floor(now() / 1_000) * 1_000,
      expiresAt: Math.floor(expiresAt / 1_000) * 1_000,
    })
  })

  test("a queued-prompt grant fixes the exact turn id and names no child", async () => {
    const { env } = await keys()
    const minted = await mintDeferredTurnGrant(deferredTurnGrantClaims(principal, "org_1", queuedRow), env, { now })
    expect(decodeJwt(minted.grant)).toMatchObject({ intent: "queued_prompt", turn_id: "msg_queued_1" })
    expect(decodeJwt(minted.grant)).not.toHaveProperty("subject_session_id")
    expect(decodeJwt(minted.grant)).not.toHaveProperty("turn_id_prefix")
    await expect(verifyDeferredTurnGrant(minted.grant, env, { sessionId: "ses_parent", now })).resolves.toMatchObject({
      intent: "queued_prompt",
      turnId: "msg_queued_1",
    })
  })

  test("a service principal mints and verifies as the agent it is", async () => {
    const { env } = await keys()
    const agent = { principalKind: "service" as const, actorId: "agent_1", actorKind: "agent" as const }
    const minted = await mintDeferredTurnGrant(deferredTurnGrantClaims(agent, "org_1", { ...queuedRow, actorId: "agent_1" }), env, { now })
    await expect(verifyDeferredTurnGrant(minted.grant, env, { sessionId: "ses_parent", now })).resolves.toMatchObject(agent)
  })

  test("minting refuses a principal the row was not minted for and a row already past its expiry", async () => {
    const { env } = await keys()
    expect(() => deferredTurnGrantClaims({ ...principal, actorId: "actor_bob" }, "org_1", wakeRow))
      .toThrow(expect.objectContaining({ code: "session_turn_grant_invalid" }))
    await expect(mintDeferredTurnGrant(deferredTurnGrantClaims(principal, "org_1", wakeRow), env, { now: () => expiresAt }))
      .rejects.toMatchObject({ code: "session_turn_grant_invalid" })
  })

  test("verification refuses another key, another audience, expiry, another session and a malformed body", async () => {
    const { env, signingKey } = await keys()
    const other = await keys()
    const claims = deferredTurnGrantClaims(principal, "org_1", wakeRow)
    const foreign = await mintDeferredTurnGrant(claims, other.env, { now })
    expect(await code(() => verifyDeferredTurnGrant(foreign.grant, env, { sessionId: "ses_parent", now }))).toBe("session_turn_grant_invalid")

    const minted = await mintDeferredTurnGrant(claims, env, { now })
    expect(await code(() => verifyDeferredTurnGrant(minted.grant, env, { sessionId: "ses_parent", now: () => expiresAt + 1_000 })))
      .toBe("session_turn_grant_expired")
    expect(await code(() => verifyDeferredTurnGrant(minted.grant, env, { sessionId: "ses_other", now }))).toBe("session_turn_grant_mismatch")
    expect(await code(() => verifyDeferredTurnGrant("not.a.jwt", env, { sessionId: "ses_parent", now }))).toBe("session_turn_grant_invalid")

    const { iss: _iss, aud: _aud, jti: _jti, iat, exp, ...body } = decodeJwt(minted.grant)
    const forge = (overrides: Record<string, unknown>, audience: string = DEFERRED_TURN_GRANT_AUDIENCE) =>
      new SignJWT({ ...body, ...overrides })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(DEFERRED_TURN_GRANT_ISSUER)
        .setAudience(audience)
        .setIssuedAt(iat)
        .setExpirationTime(exp!)
        .setJti("grant_forged")
        .sign(signingKey)
    const refused = async (token: string) => code(() => verifyDeferredTurnGrant(token, env, { sessionId: "ses_parent", now }))

    expect(await refused(await forge({}, "workspace-runtime-session-turn"))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ session_id: undefined }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ principal_kind: "user", actor_kind: "agent" }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ intent: "anything" }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ turn_id_prefix: "msg_wake_ses_other_" }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ turn_id: "msg_1" }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ intent: "queued_prompt" }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({ intent: "queued_prompt", subject_session_id: undefined, turn_id_prefix: undefined }))).toBe("session_turn_grant_invalid")
    expect(await refused(await forge({}))).toBeUndefined()
  })

  test("a deployment without the runtime key pair cannot mint or verify, and says so as a fault", async () => {
    const { env } = await keys()
    const claims = deferredTurnGrantClaims(principal, "org_1", wakeRow)
    await expect(mintDeferredTurnGrant(claims, {}, { now })).rejects.toBeInstanceOf(DeferredTurnGrantConfigurationError)
    const minted = await mintDeferredTurnGrant(claims, env, { now })
    await expect(verifyDeferredTurnGrant(minted.grant, {}, { sessionId: "ses_parent", now })).rejects.toBeInstanceOf(DeferredTurnGrantConfigurationError)
  })
})
