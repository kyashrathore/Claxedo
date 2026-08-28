import { kyselyAdapter } from "@better-auth/kysely-adapter"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { DBAdapter } from "@better-auth/core/db/adapter"
import {
  Kysely,
  SqliteAdapter,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from "kysely"

class D1Connection implements DatabaseConnection {
  constructor(private readonly database: D1Database) {}

  async executeQuery<Result>(query: CompiledQuery): Promise<QueryResult<Result>> {
    const result = await this.database.prepare(query.sql).bind(...query.parameters).all<Result>()
    return {
      rows: result.results ?? [],
      numAffectedRows: result.meta.changes == null ? undefined : BigInt(result.meta.changes),
      insertId: result.meta.last_row_id == null ? undefined : BigInt(result.meta.last_row_id),
    }
  }

  async *streamQuery<Result>(): AsyncIterableIterator<QueryResult<Result>> {
    throw new Error("D1 does not support streaming queries")
  }
}

class D1Driver implements Driver {
  private readonly connection: DatabaseConnection

  constructor(database: D1Database) {
    this.connection = new D1Connection(database)
  }

  async init() {}

  async acquireConnection() {
    return this.connection
  }

  async beginTransaction(_connection: DatabaseConnection, _settings: TransactionSettings) {
    throw new Error("D1 does not support interactive transactions")
  }

  async commitTransaction() {
    throw new Error("D1 does not support interactive transactions")
  }

  async rollbackTransaction() {
    throw new Error("D1 does not support interactive transactions")
  }

  async releaseConnection() {}

  async destroy() {}
}

class D1Dialect implements Dialect {
  constructor(private readonly database: D1Database) {}

  createDriver() {
    return new D1Driver(this.database)
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler()
  }

  createAdapter() {
    return new SqliteAdapter()
  }

  createIntrospector(_database: Kysely<unknown>) {
    const unsupported = async (): Promise<never> => {
      throw new Error("Live D1 introspection is disabled; apply checked migrations through deployment tooling")
    }
    return { getSchemas: unsupported, getTables: unsupported }
  }
}

/**
 * Builds the Better Auth adapter explicitly so the Worker bundle never loads
 * Better Auth's Node database auto-detection path. D1 has no interactive
 * transactions, so only the audited create and verification-consume shapes
 * receive transaction semantics; all other mutating callback shapes fail.
 */
export function betterAuthD1Adapter(database: D1Database) {
  const kysely = new Kysely<unknown>({ dialect: new D1Dialect(database) })
  const createSequentialAdapter = kyselyAdapter(kysely, { type: "sqlite", transaction: false })
  return (options: Parameters<typeof createSequentialAdapter>[0]) => Object.assign(
    createSequentialAdapter(options),
    {
      [BETTER_AUTH_D1_ATOMIC]: {
        createUserAccount: async (user: Record<string, unknown>, account: Record<string, unknown>) => {
          assertIdentityBinding(user, account)
          const results = await database.batch([
            fixedInsert(database, "user", USER_FIELDS, user),
            fixedInsert(database, "account", ACCOUNT_FIELDS, account),
          ])
          if (results.some((result) => !result.success)) {
            throw new Error("Better Auth D1 user/account batch failed")
          }
          return { user, account }
        },
        rotateRefreshToken: async (parent, child, update) => {
          assertRefreshRotation(parent, child, update)
          const rotationNonce = requiredString(update, "rotationNonce", "oauthRefreshToken")
          let results
          try {
            results = await database.batch([
              database.prepare(`update "oauthRefreshToken"
                set "revoked" = ?, "rotatedAt" = ?, "rotationNonce" = ?
                where "id" = ? and "clientId" = ? and "familyId" = ? and "generation" = ?
                  and "revoked" is null and "rotatedAt" is null`)
                .bind(
                  d1Value(update.revoked),
                  d1Value(update.rotatedAt),
                  rotationNonce,
                  parent.id as string,
                  parent.clientId as string,
                  parent.familyId as string,
                  parent.generation as number,
                ),
              conditionalRefreshInsert(database, parent, child, update, rotationNonce),
            ])
          } catch (error) {
            const committedChild = await findCommittedRefreshChild(database, parent, child)
            if (committedChild) return child
            const currentParent = await database.prepare(`select "revoked", "rotatedAt"
              from "oauthRefreshToken" where "id" = ? and "familyId" = ? and "generation" = ?`)
              .bind(parent.id as string, parent.familyId as string, parent.generation as number)
              .first<{ revoked: string | null; rotatedAt: string | null }>()
            if (!currentParent || currentParent.revoked != null || currentParent.rotatedAt != null) return undefined
            throw error
          }
          if (results.some((result) => !result.success)) {
            throw new Error("Better Auth D1 refresh rotation batch failed")
          }
          if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) return undefined
          return child
        },
        invalidateRefreshFamily: async ({ familyId, clientId }) => {
          if (!familyId || !clientId) {
            throw new Error("Better Auth D1 refresh-family invalidation is missing its canonical binding")
          }
          const result = await database.prepare(`delete from "oauthRefreshToken"
            where "familyId" = ? and "clientId" = ?`).bind(familyId, clientId).run()
          if (!result.success) {
            throw new Error("Better Auth D1 refresh-family invalidation batch failed")
          }
        },
      } satisfies BetterAuthD1AtomicCapability,
    },
  ) satisfies DBAdapter
}

export const BETTER_AUTH_D1_ATOMIC = Symbol.for("claxedo.better-auth.d1.atomic.v1")

export type BetterAuthD1AtomicCapability = {
  createUserAccount(
    user: Record<string, unknown>,
    account: Record<string, unknown>,
  ): Promise<{ user: Record<string, unknown>; account: Record<string, unknown> }>
  rotateRefreshToken(
    parent: Record<string, unknown>,
    child: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>
  invalidateRefreshFamily(input: {
    familyId: string
    clientId: string
  }): Promise<void>
}

const USER_FIELDS = new Set(["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"])
const ACCOUNT_FIELDS = new Set([
  "id",
  "issuer",
  "accountId",
  "providerId",
  "userId",
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "scope",
  "password",
  "createdAt",
  "updatedAt",
])
const REFRESH_TOKEN_FIELDS = new Set([
  "id",
  "token",
  "clientId",
  "sessionId",
  "userId",
  "referenceId",
  "authorizationCodeId",
  "resources",
  "requestedUserInfoClaims",
  "expiresAt",
  "createdAt",
  "revoked",
  "rotatedAt",
  "rotationReplayResponse",
  "rotationReplayExpiresAt",
  "authTime",
  "confirmation",
  "scopes",
  "familyId",
  "parentId",
  "generation",
  "rotationNonce",
])

function requiredString(
  record: Record<string, unknown>,
  field: string,
  table: "user" | "account" | "oauthRefreshToken",
) {
  const value = record[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Better Auth D1 ${table}.${field} must be a non-empty string`)
  }
  return value
}

function assertRefreshRotation(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  const parentId = requiredString(parent, "id", "oauthRefreshToken")
  const clientId = requiredString(parent, "clientId", "oauthRefreshToken")
  const familyId = requiredString(parent, "familyId", "oauthRefreshToken")
  const generation = parent.generation
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new Error("Better Auth D1 oauthRefreshToken.generation must be a non-negative safe integer")
  }
  requiredString(child, "id", "oauthRefreshToken")
  requiredString(child, "token", "oauthRefreshToken")
  requiredString(child, "userId", "oauthRefreshToken")
  if (requiredString(child, "parentId", "oauthRefreshToken") !== parentId) {
    throw new Error("Better Auth D1 refresh child.parentId must match its parent.id")
  }
  if (requiredString(child, "clientId", "oauthRefreshToken") !== clientId) {
    throw new Error("Better Auth D1 refresh child.clientId must match its parent.clientId")
  }
  if (requiredString(child, "familyId", "oauthRefreshToken") !== familyId) {
    throw new Error("Better Auth D1 refresh child.familyId must match its parent.familyId")
  }
  if (child.generation !== (generation as number) + 1) {
    throw new Error("Better Auth D1 refresh child.generation must immediately follow its parent")
  }
  if (!(update.revoked instanceof Date) || !(update.rotatedAt instanceof Date)) {
    throw new Error("Better Auth D1 refresh rotation requires canonical timestamps")
  }
}

function assertIdentityBinding(user: Record<string, unknown>, account: Record<string, unknown>) {
  const userId = requiredString(user, "id", "user")
  if (typeof user.name !== "string") {
    throw new Error("Better Auth D1 user.name must be a string")
  }
  requiredString(user, "email", "user")
  requiredString(account, "id", "account")
  const accountId = requiredString(account, "accountId", "account")
  const providerId = requiredString(account, "providerId", "account")
  requiredString(account, "issuer", "account")
  if (requiredString(account, "userId", "account") !== userId) {
    throw new Error("Better Auth D1 account.userId must match the atomically created user.id")
  }
  if (providerId === "credential" && accountId !== userId) {
    throw new Error("Better Auth D1 credential accountId must match the atomically created user.id")
  }
}

function fixedInsert(
  database: D1Database,
  table: "user" | "account",
  allowed: ReadonlySet<string>,
  record: Record<string, unknown>,
): D1PreparedStatement {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  if (entries.length === 0 || entries.some(([field]) => !allowed.has(field))) {
    throw new Error(`Better Auth D1 ${table} record contains unsupported fields`)
  }
  const fields = entries.map(([field]) => `"${field}"`).join(", ")
  const values = entries.map(([, value]) => {
    return d1Value(value)
  })
  return database
    .prepare(`insert into "${table}" (${fields}) values (${entries.map(() => "?").join(", ")})`)
    .bind(...values)
}

function conditionalRefreshInsert(
  database: D1Database,
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
  update: Record<string, unknown>,
  rotationNonce: string,
) {
  if (Object.keys(child).some((field) => !REFRESH_TOKEN_FIELDS.has(field))) {
    throw new Error("Better Auth D1 oauthRefreshToken record contains unsupported fields")
  }
  return database.prepare(`insert into "oauthRefreshToken" (
      "id", "token", "clientId", "sessionId", "userId", "referenceId", "authorizationCodeId",
      "authTime", "confirmation", "requestedUserInfoClaims", "scopes", "resources", "createdAt", "expiresAt",
      "familyId", "parentId", "generation"
    )
    select ?, ?, parent."clientId", parent."sessionId", parent."userId", parent."referenceId",
      parent."authorizationCodeId", parent."authTime", ?, ?, ?, ?, ?, ?, parent."familyId", parent."id",
      parent."generation" + 1
    from "oauthRefreshToken" as parent
    where parent."id" = ? and parent."clientId" = ? and parent."familyId" = ? and parent."generation" = ?
      and parent."revoked" = ? and parent."rotatedAt" = ? and parent."rotationNonce" = ?
      and not exists (select 1 from "oauthRefreshToken" as child where child."parentId" = parent."id")`)
    .bind(
      child.id as string,
      child.token as string,
      d1Value(child.confirmation),
      d1Value(child.requestedUserInfoClaims),
      d1Value(child.scopes),
      d1Value(child.resources),
      d1Value(child.createdAt),
      d1Value(child.expiresAt),
      parent.id as string,
      parent.clientId as string,
      parent.familyId as string,
      parent.generation as number,
      d1Value(update.revoked),
      d1Value(update.rotatedAt),
      rotationNonce,
    )
}

async function findCommittedRefreshChild(
  database: D1Database,
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
) {
  const committed = await database.prepare(`select "id" from "oauthRefreshToken"
    where "id" = ? and "parentId" = ? and "familyId" = ? and "generation" = ? and "token" = ?`)
    .bind(
      child.id as string,
      parent.id as string,
      parent.familyId as string,
      child.generation as number,
      child.token as string,
    )
    .first<{ id: string }>()
  return committed?.id === child.id
}

function d1Value(value: unknown): string | number | null {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "boolean") return value ? 1 : 0
  if (Array.isArray(value) || value && typeof value === "object") return JSON.stringify(value)
  return value as string | number | null
}
