import type { GenericEndpointContext } from "@better-auth/core"
import type { BetterAuthOptions } from "better-auth"
import type { D1Database } from "@cloudflare/workers-types"

import {
  AuthenticationError,
  type AuthAssurance,
  type AuthenticationEvidenceMethod,
} from "@claxedo/server-core/platform/auth/authentication"

import type {
  BetterAuthAuthenticationEvidenceInput,
  BetterAuthAuthenticationEvidenceResolver,
} from "./better-auth-d1-request-authentication"

type SessionRecord = {
  id: string
  userId: string
  createdAt: Date | string | number
} & Record<string, unknown>

type SessionCreateHook = NonNullable<
  NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["create"]
>

type Evidence = {
  methods: readonly [AuthenticationEvidenceMethod]
  assurance: AuthAssurance
}

type EvidenceRow = {
  sessionId: unknown
  subject: unknown
  authenticatedAt: unknown
  methods: unknown
  assurance: unknown
  sessionSubject: unknown
  sessionCreatedAt: unknown
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
}

function timestamp(value: unknown): number {
  const result = value instanceof Date
    ? value.getTime()
    : typeof value === "string" || typeof value === "number"
      ? new Date(value).getTime()
      : Number.NaN
  if (!Number.isFinite(result) || result <= 0) throw invalidCredentials()
  return result
}

function signInEvidence(context: GenericEndpointContext | null): Evidence {
  if (context?.path === "/sign-in/email") {
    return { methods: ["password"], assurance: "single-factor" }
  }
  if (context?.path === "/callback/:id") {
    if (context.params?.id === "google") {
      return { methods: ["oauth:google"], assurance: "single-factor" }
    }
    if (context.params?.id === "github") {
      return { methods: ["oauth:github"], assurance: "single-factor" }
    }
  }
  throw new Error("Better Auth session creation has no supported authentication provenance")
}

function sameDate(left: unknown, right: unknown) {
  try {
    return timestamp(left) === timestamp(right)
  } catch {
    return false
  }
}

function sameString(left: unknown, right: unknown) {
  return typeof left === "string" && typeof right === "string" && left === right
}

function assertSessionBindingUnchanged(
  original: SessionRecord,
  result: Awaited<ReturnType<NonNullable<SessionCreateHook["before"]>>>,
) {
  if (!result || typeof result !== "object" || !("data" in result)) return
  const data = result.data as Partial<SessionRecord>
  if (
    (data.id !== undefined && !sameString(data.id, original.id))
    || (data.userId !== undefined && !sameString(data.userId, original.userId))
    || (data.createdAt !== undefined && !sameDate(data.createdAt, original.createdAt))
  ) {
    throw new Error("Better Auth session hook changed its authentication evidence binding")
  }
}

async function persistEvidence(database: D1Database, session: SessionRecord, evidence: Evidence) {
  const authenticatedAt = timestamp(session.createdAt)
  try {
    const result = await database.prepare(`insert into "authenticationEvidence"
      ("sessionId", "subject", "authenticatedAt", "methods", "assurance", "createdAt")
      values (?, ?, ?, ?, ?, ?)`).bind(
        session.id,
        session.userId,
        authenticatedAt,
        JSON.stringify(evidence.methods),
        evidence.assurance,
        Date.now(),
      ).run()
    if (result.meta.changes !== 1) throw new Error("Authentication evidence was not persisted")
  } catch (error) {
    // A hook failure must never leave a usable session without evidence. A
    // crash in this interval is also fail-closed because the resolver requires
    // the evidence row before accepting either cookie or bearer credentials.
    await database.prepare(`delete from "session" where "id" = ?`).bind(session.id).run().catch(() => {})
    throw error
  }
}

/**
 * Adds the canonical evidence hook while preserving caller-owned hooks. The
 * producer path, not linked-account state, determines the authentication method.
 */
export function betterAuthD1AuthenticationEvidenceHooks(
  database: D1Database,
  hooks?: BetterAuthOptions["databaseHooks"],
): BetterAuthOptions["databaseHooks"] {
  const externalCreate = hooks?.session?.create
  return {
    ...hooks,
    session: {
      ...hooks?.session,
      create: {
        ...externalCreate,
        async before(session, context) {
          // Reject unknown producers before Better Auth inserts a session.
          signInEvidence(context)
          const result = await externalCreate?.before?.(session, context)
          assertSessionBindingUnchanged(session as SessionRecord, result)
          return result
        },
        async after(session, context) {
          await persistEvidence(database, session as SessionRecord, signInEvidence(context))
          await externalCreate?.after?.(session, context)
        },
      },
    },
  }
}

function parsePersistedEvidence(row: EvidenceRow | null) {
  if (
    !row
    || typeof row.sessionId !== "string"
    || typeof row.subject !== "string"
    || row.sessionSubject !== row.subject
  ) throw invalidCredentials()

  const authenticatedAt = timestamp(row.authenticatedAt)
  if (timestamp(row.sessionCreatedAt) !== authenticatedAt) throw invalidCredentials()

  let methods: unknown
  try {
    methods = typeof row.methods === "string" ? JSON.parse(row.methods) : undefined
  } catch {
    throw invalidCredentials()
  }
  if (
    !Array.isArray(methods)
    || methods.length !== 1
    || !["password", "oauth:google", "oauth:github"].includes(methods[0])
    || row.assurance !== "single-factor"
  ) throw invalidCredentials()

  return {
    sessionId: row.sessionId,
    subject: row.subject,
    authenticatedAt,
    methods: methods as [AuthenticationEvidenceMethod],
    assurance: row.assurance as AuthAssurance,
  }
}

async function evidenceRow(database: D1Database, sessionId: string) {
  return database.prepare(`select
      evidence."sessionId" as "sessionId",
      evidence."subject" as "subject",
      evidence."authenticatedAt" as "authenticatedAt",
      evidence."methods" as "methods",
      evidence."assurance" as "assurance",
      session."userId" as "sessionSubject",
      session."createdAt" as "sessionCreatedAt"
    from "authenticationEvidence" as evidence
    inner join "session" as session on session."id" = evidence."sessionId"
    where evidence."sessionId" = ?`)
    .bind(sessionId)
    .first<EvidenceRow>()
}

/** Resolve only immutable evidence tied to the exact verified Better Auth session. */
export function createBetterAuthD1AuthenticationEvidenceResolver(
  database: D1Database,
): BetterAuthAuthenticationEvidenceResolver {
  return async (input: BetterAuthAuthenticationEvidenceInput) => {
    if (!input.providerSessionId) throw invalidCredentials()
    const evidence = parsePersistedEvidence(await evidenceRow(database, input.providerSessionId))
    if (evidence.subject !== input.subject) throw invalidCredentials()
    if (input.kind === "browser" && evidence.authenticatedAt !== input.providerSessionCreatedAt) {
      throw invalidCredentials()
    }
    // OAuth `iat` is seconds while Better Auth session creation is milliseconds.
    if (input.kind !== "browser" && input.issuedAt !== undefined && input.issuedAt + 999 < evidence.authenticatedAt) {
      throw invalidCredentials()
    }
    return {
      sessionId: evidence.sessionId,
      authenticatedAt: evidence.authenticatedAt,
      methods: evidence.methods,
      assurance: evidence.assurance,
    }
  }
}
