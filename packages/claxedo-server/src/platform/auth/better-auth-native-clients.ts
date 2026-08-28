import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { constantTimeEqual, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"

import { BETTER_AUTH_NATIVE_SCOPES } from "./better-auth-d1-foundation"

export const BETTER_AUTH_CLI_CLIENT_ID = "claxedo-cli"
export const BETTER_AUTH_DESKTOP_CLIENT_ID = "claxedo-desktop"
export const BETTER_AUTH_INTROSPECTION_CLIENT_ID = "claxedo-control-plane"

const BETTER_AUTH_REQUIRED_SCHEMA = {
  user: ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"],
  session: ["id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"],
  account: [
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
  ],
  verification: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"],
  jwks: ["id", "publicKey", "privateKey", "createdAt", "expiresAt", "alg", "crv"],
  oauthClient: [
    "id",
    "clientId",
    "clientSecret",
    "clientDiscoveryId",
    "disabled",
    "skipConsent",
    "enableEndSession",
    "subjectType",
    "scopes",
    "clientCredentialsScopes",
    "userId",
    "createdAt",
    "updatedAt",
    "name",
    "uri",
    "icon",
    "contacts",
    "tos",
    "policy",
    "softwareId",
    "softwareVersion",
    "softwareStatement",
    "redirectUris",
    "postLogoutRedirectUris",
    "backchannelLogoutUri",
    "backchannelLogoutSessionRequired",
    "tokenEndpointAuthMethod",
    "applicationType",
    "jwks",
    "jwksUri",
    "grantTypes",
    "responseTypes",
    "requirePKCE",
    "dpopBoundAccessTokens",
    "referenceId",
    "metadata",
  ],
  oauthResource: [
    "id",
    "identifier",
    "name",
    "accessTokenTtl",
    "refreshTokenTtl",
    "signingAlgorithm",
    "signingKeyId",
    "allowedScopes",
    "customClaims",
    "dpopBoundAccessTokensRequired",
    "disabled",
    "createdAt",
    "updatedAt",
    "policyVersion",
    "metadata",
  ],
  oauthClientResource: ["id", "clientId", "resourceId", "metadata", "createdAt"],
  oauthRefreshToken: [
    "id",
    "token",
    "clientId",
    "sessionId",
    "userId",
    "referenceId",
    "authorizationCodeId",
    "resources",
    "requestedUserInfoClaims",
    "familyId",
    "parentId",
    "generation",
    "rotationNonce",
    "expiresAt",
    "createdAt",
    "revoked",
    "rotatedAt",
    "rotationReplayResponse",
    "rotationReplayExpiresAt",
    "authTime",
    "confirmation",
    "scopes",
  ],
  oauthAccessToken: [
    "id",
    "token",
    "clientId",
    "sessionId",
    "userId",
    "referenceId",
    "authorizationCodeId",
    "resources",
    "requestedUserInfoClaims",
    "refreshId",
    "expiresAt",
    "createdAt",
    "revoked",
    "confirmation",
    "scopes",
  ],
  oauthConsent: [
    "id",
    "clientId",
    "userId",
    "referenceId",
    "resources",
    "requestedUserInfoClaims",
    "scopes",
    "createdAt",
    "updatedAt",
  ],
  oauthClientAssertion: ["id", "expiresAt"],
  deviceCode: [
    "id",
    "deviceCode",
    "userCode",
    "userId",
    "approvalSessionId",
    "approvalAuthTime",
    "expiresAt",
    "status",
    "lastPolledAt",
    "pollingInterval",
    "clientId",
    "scope",
    "resources",
    "oauthClientId",
  ],
  authenticationEvidence: ["sessionId", "subject", "authenticatedAt", "methods", "assurance", "createdAt"],
  deploymentRelease: [
    "deploymentId",
    "releaseSequence",
    "releaseId",
    "workerBuildId",
    "platformVersionId",
    "browserBuildId",
    "relayBuildId",
    "authConfigurationId",
    "requestLimiterNamespaceId",
    "adapterProfile",
    "productPosture",
    "sandboxPosture",
    "serviceManifestId",
    "createdAt",
  ],
  deploymentReleaseStateHistory: [
    "deploymentId",
    "stateRevision",
    "operationId",
    "releaseId",
    "previousStateRevision",
    "restoredStateRevision",
    "transitionKind",
    "phase",
    "phaseRevision",
    "firstTargetWriteAt",
    "createdAt",
  ],
  deploymentReleaseActive: ["singleton", "deploymentId", "stateRevision", "updatedAt"],
  deploymentRecoveryEpoch: ["deploymentId", "releaseId", "recoveryEpoch", "createdAt"],
  deploymentCutoverCanaryAdmission: [
    "deploymentId",
    "releaseId",
    "workerBuildId",
    "platformVersionId",
    "browserBuildId",
    "relayBuildId",
    "authConfigurationId",
    "adapterProfile",
    "productPosture",
    "sandboxPosture",
    "serviceManifestId",
    "sourceStateRevision",
    "sourcePhaseRevision",
    "receiptId",
    "operationId",
    "operatorSubjectHash",
    "canaryIdentityHash",
    "journeyId",
    "createdAt",
  ],
  deploymentCutoverEvidenceReceipt: [
    "deploymentId",
    "releaseId",
    "workerBuildId",
    "platformVersionId",
    "browserBuildId",
    "relayBuildId",
    "authConfigurationId",
    "adapterProfile",
    "productPosture",
    "sandboxPosture",
    "serviceManifestId",
    "sourceStateRevision",
    "sourcePhaseRevision",
    "receiptId",
    "operationId",
    "evidenceKind",
    "evidenceSlot",
    "primarySubjectHash",
    "secondarySubjectHash",
    "observedCount",
    "evidenceReference",
    "recoveryEpoch",
    "artifactSha256",
    "secondaryArtifactSha256",
    "createdAt",
  ],
} as const

const BETTER_AUTH_REQUIRED_INDEXES = [
  ["session_userId_idx", "session", 0, "userId"],
  ["account_userId_idx", "account", 0, "userId"],
  ["verification_identifier_idx", "verification", 0, "identifier"],
  ["oauthClient_userId_idx", "oauthClient", 0, "userId"],
  ["oauthClientResource_clientId_idx", "oauthClientResource", 0, "clientId"],
  ["oauthClientResource_resourceId_idx", "oauthClientResource", 0, "resourceId"],
  ["oauthRefreshToken_clientId_idx", "oauthRefreshToken", 0, "clientId"],
  ["oauthRefreshToken_sessionId_idx", "oauthRefreshToken", 0, "sessionId"],
  ["oauthRefreshToken_userId_idx", "oauthRefreshToken", 0, "userId"],
  ["oauthRefreshToken_authorizationCodeId_idx", "oauthRefreshToken", 0, "authorizationCodeId"],
  ["oauthRefreshToken_familyId_idx", "oauthRefreshToken", 0, "familyId"],
  ["oauthAccessToken_clientId_idx", "oauthAccessToken", 0, "clientId"],
  ["oauthAccessToken_sessionId_idx", "oauthAccessToken", 0, "sessionId"],
  ["oauthAccessToken_userId_idx", "oauthAccessToken", 0, "userId"],
  ["oauthAccessToken_authorizationCodeId_idx", "oauthAccessToken", 0, "authorizationCodeId"],
  ["oauthAccessToken_refreshId_idx", "oauthAccessToken", 0, "refreshId"],
  ["oauthConsent_clientId_idx", "oauthConsent", 0, "clientId"],
  ["oauthConsent_userId_idx", "oauthConsent", 0, "userId"],
  ["account_issuer_accountId_uidx", "account", 1, "issuer,accountId"],
  ["oauthClientResource_clientId_resourceId_uidx", "oauthClientResource", 1, "clientId,resourceId"],
  ["oauthRefreshToken_familyId_generation_uidx", "oauthRefreshToken", 1, "familyId,generation"],
  ["deviceCode_deviceCode_uidx", "deviceCode", 1, "deviceCode"],
  ["deviceCode_userCode_uidx", "deviceCode", 1, "userCode"],
  [
    "deploymentCutoverEvidence_distinct_multiplayer_identity",
    "deploymentCutoverEvidenceReceipt",
    1,
    "deploymentId,releaseId,primarySubjectHash",
  ],
  ["deploymentCutoverEvidence_one_source_boundary", "deploymentCutoverEvidenceReceipt", 1, "deploymentId,releaseId"],
] as const

const BETTER_AUTH_REQUIRED_UNIQUE_DDL = [
  ["user", `"email"textnotnullunique`],
  ["session", `"token"textnotnullunique`],
  ["oauthClient", `"clientId"textnotnullunique`],
  ["oauthResource", `"identifier"textnotnullunique`],
  ["oauthRefreshToken", `"token"textnotnullunique`],
  ["oauthRefreshToken", `"parentId"textunique`],
  ["oauthRefreshToken", `"rotationNonce"textunique`],
  ["oauthAccessToken", `"token"textnotnullunique`],
  ["deploymentRelease", `primarykey("deploymentId","releaseId")`],
  ["deploymentRelease", `unique("deploymentId","releaseSequence")`],
  ["deploymentReleaseStateHistory", `primarykey("deploymentId","stateRevision")`],
  ["deploymentReleaseStateHistory", `unique("deploymentId","operationId")`],
  ["deploymentRecoveryEpoch", `primarykey("deploymentId","releaseId")`],
  ["deploymentRecoveryEpoch", `"recoveryEpoch"textnotnullunique`],
  ["authenticationEvidence", `"sessionId"textnotnullprimarykey`],
  [
    "authenticationEvidence",
    `"methods"textnotnullcheck("methods"in('["password"]','["oauth:google"]','["oauth:github"]'))`,
  ],
  ["authenticationEvidence", `"assurance"textnotnullcheck("assurance"='single-factor')`],
] as const

const BETTER_AUTH_APPEND_ONLY_TRIGGERS = [
  "deploymentRelease_no_update",
  "deploymentRelease_no_delete",
  "deploymentReleaseStateHistory_no_update",
  "deploymentReleaseStateHistory_no_delete",
  "authenticationEvidence_session_binding_insert",
  "authenticationEvidence_no_update",
  "authenticationEvidence_no_direct_delete",
  "deploymentCutoverCanaryAdmission_no_update",
  "deploymentCutoverCanaryAdmission_no_delete",
  "deploymentCutoverEvidenceReceipt_no_update",
  "deploymentCutoverEvidenceReceipt_no_delete",
  "deploymentRecoveryEpoch_no_update",
  "deploymentRecoveryEpoch_no_delete",
] as const

export function betterAuthNativeResource(apiOrigin: string) {
  const origin = new URL(apiOrigin)
  if (origin.protocol !== "https:" || origin.origin !== apiOrigin || origin.username || origin.password) {
    throw new Error("Better Auth native resource requires an exact HTTPS API origin")
  }
  return `${origin.origin}/control-plane`
}

type NativeClientStatement = { sql: string; values: Array<string | number | null> }

function betterAuthNativeClientStatementDefinitions(apiOrigin: string, introspectionClientSecretCiphertext: string) {
  const resource = betterAuthNativeResource(apiOrigin)
  const scopes = JSON.stringify(BETTER_AUTH_NATIVE_SCOPES)
  if (introspectionClientSecretCiphertext.length < 64) {
    throw new Error("Better Auth introspection client secret ciphertext is invalid")
  }
  const definitions: NativeClientStatement[] = [
    {
      sql: `insert into "oauthResource"
      ("id", "identifier", "name", "accessTokenTtl", "refreshTokenTtl", "allowedScopes", "disabled", "policyVersion")
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict ("identifier") do update set
        "name" = excluded."name",
        "accessTokenTtl" = excluded."accessTokenTtl",
        "refreshTokenTtl" = excluded."refreshTokenTtl",
        "allowedScopes" = excluded."allowedScopes",
        "disabled" = excluded."disabled",
        "policyVersion" = excluded."policyVersion"`,
      values: ["resource_control_plane", resource, "Claxedo control plane", 300, 2_592_000, scopes, 0, 1],
    },
    {
      sql: `insert into "oauthClient"
      ("id", "clientId", "disabled", "skipConsent", "enableEndSession", "subjectType", "scopes", "redirectUris", "tokenEndpointAuthMethod", "applicationType", "grantTypes", "responseTypes", "requirePKCE")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict ("clientId") do update set
        "disabled" = excluded."disabled",
        "skipConsent" = excluded."skipConsent",
        "enableEndSession" = excluded."enableEndSession",
        "subjectType" = excluded."subjectType",
        "scopes" = excluded."scopes",
        "redirectUris" = excluded."redirectUris",
        "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
        "applicationType" = excluded."applicationType",
        "grantTypes" = excluded."grantTypes",
        "responseTypes" = excluded."responseTypes",
        "requirePKCE" = excluded."requirePKCE"`,
      values: [
        "client_cli",
        BETTER_AUTH_CLI_CLIENT_ID,
        0,
        0,
        0,
        "public",
        scopes,
        "[]",
        "none",
        "native",
        JSON.stringify(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]),
        JSON.stringify(["code"]),
        1,
      ],
    },
    {
      sql: `insert into "oauthClient"
      ("id", "clientId", "disabled", "skipConsent", "enableEndSession", "subjectType", "scopes", "redirectUris", "tokenEndpointAuthMethod", "applicationType", "grantTypes", "responseTypes", "requirePKCE")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict ("clientId") do update set
        "disabled" = excluded."disabled",
        "skipConsent" = excluded."skipConsent",
        "enableEndSession" = excluded."enableEndSession",
        "subjectType" = excluded."subjectType",
        "scopes" = excluded."scopes",
        "redirectUris" = excluded."redirectUris",
        "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
        "applicationType" = excluded."applicationType",
        "grantTypes" = excluded."grantTypes",
        "responseTypes" = excluded."responseTypes",
        "requirePKCE" = excluded."requirePKCE"`,
      values: [
        "client_desktop",
        BETTER_AUTH_DESKTOP_CLIENT_ID,
        0,
        0,
        0,
        "public",
        scopes,
        JSON.stringify(["http://127.0.0.1/callback"]),
        "none",
        "native",
        JSON.stringify(["authorization_code", "refresh_token"]),
        JSON.stringify(["code"]),
        1,
      ],
    },
    {
      sql: `insert into "oauthClient"
      ("id", "clientId", "clientSecret", "disabled", "skipConsent", "enableEndSession", "subjectType", "scopes", "redirectUris", "tokenEndpointAuthMethod", "applicationType", "grantTypes", "responseTypes", "requirePKCE")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict ("clientId") do update set
        "clientSecret" = excluded."clientSecret",
        "disabled" = excluded."disabled",
        "skipConsent" = excluded."skipConsent",
        "enableEndSession" = excluded."enableEndSession",
        "subjectType" = excluded."subjectType",
        "scopes" = excluded."scopes",
        "redirectUris" = excluded."redirectUris",
        "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
        "applicationType" = excluded."applicationType",
        "grantTypes" = excluded."grantTypes",
        "responseTypes" = excluded."responseTypes",
        "requirePKCE" = excluded."requirePKCE"`,
      values: [
        "client_control_plane",
        BETTER_AUTH_INTROSPECTION_CLIENT_ID,
        introspectionClientSecretCiphertext,
        0,
        1,
        0,
        "public",
        "[]",
        "[]",
        "client_secret_post",
        "web",
        "[]",
        "[]",
        0,
      ],
    },
    {
      sql: `insert into "oauthClientResource" ("id", "clientId", "resourceId")
      values (?, ?, ?) on conflict ("clientId", "resourceId") do nothing`,
      values: ["client_resource_cli", BETTER_AUTH_CLI_CLIENT_ID, resource],
    },
    {
      sql: `insert into "oauthClientResource" ("id", "clientId", "resourceId")
      values (?, ?, ?) on conflict ("clientId", "resourceId") do nothing`,
      values: ["client_resource_desktop", BETTER_AUTH_DESKTOP_CLIENT_ID, resource],
    },
    {
      sql: `insert into "oauthClientResource" ("id", "clientId", "resourceId")
      values (?, ?, ?) on conflict ("clientId", "resourceId") do nothing`,
      values: ["client_resource_control_plane", BETTER_AUTH_INTROSPECTION_CLIENT_ID, resource],
    },
  ]
  return { resource, definitions }
}

export function betterAuthNativeClientStatements(
  database: D1Database,
  apiOrigin: string,
  introspectionClientSecretCiphertext: string,
) {
  const { resource, definitions } = betterAuthNativeClientStatementDefinitions(
    apiOrigin,
    introspectionClientSecretCiphertext,
  )
  const statements: D1PreparedStatement[] = definitions.map(({ sql, values }) => database.prepare(sql).bind(...values))
  return { resource, statements }
}

function sqliteLiteral(value: string | number | null) {
  if (value === null) return "null"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQLite provisioning values must be finite")
    return String(value)
  }
  return `'${value.replaceAll("'", "''")}'`
}

/** Render the same canonical definitions for Wrangler's remote D1 installer. */
export function betterAuthNativeClientProvisioningStatements(
  apiOrigin: string,
  introspectionClientSecretCiphertext: string,
) {
  const { definitions } = betterAuthNativeClientStatementDefinitions(apiOrigin, introspectionClientSecretCiphertext)
  return definitions.map(({ sql, values }) => {
    let index = 0
    const rendered = sql.replaceAll("?", () => {
      const value = values[index++]
      if (value === undefined) throw new Error("Native-client provisioning statement is missing a value")
      return sqliteLiteral(value)
    })
    if (index !== values.length) throw new Error("Native-client provisioning statement has unused values")
    return `${rendered};`
  })
}

export async function betterAuthIntrospectionClientSecretCiphertext(betterAuthSecret: string, secret: string) {
  if (betterAuthSecret.length < 32) throw new Error("Better Auth secret must be at least 32 characters")
  if (secret.length < 32) throw new Error("Better Auth introspection client secret must be at least 32 characters")
  return symmetricEncrypt({ key: betterAuthSecret, data: secret })
}

export async function provisionBetterAuthNativeClients(
  database: D1Database,
  apiOrigin: string,
  betterAuthSecret: string,
  introspectionClientSecret: string,
) {
  const provisioning = betterAuthNativeClientStatements(
    database,
    apiOrigin,
    await betterAuthIntrospectionClientSecretCiphertext(betterAuthSecret, introspectionClientSecret),
  )
  await database.batch(provisioning.statements)
  return provisioning.resource
}

function normalizedSchemaSql(column: string) {
  return `lower(replace(replace(replace(replace(${column}, ' ', ''), char(9), ''), char(10), ''), char(13), ''))`
}

export function betterAuthDatabaseSchemaInspectionSql() {
  const tableChecks = Object.entries(BETTER_AUTH_REQUIRED_SCHEMA).map(([table, columns]) => {
    const references = columns.map((column) => `"${column}"`).join(", ")
    return `(select count(*) from "${table}" where 0 and coalesce(${references}) is null) as "${table}"`
  })
  const indexChecks = BETTER_AUTH_REQUIRED_INDEXES.map(
    ([name, table, unique, columns]) =>
      `case when
      (select count(*) from pragma_index_list(${sqliteLiteral(table)})
        where "name" = ${sqliteLiteral(name)} and "unique" = ${unique}) = 1
      and (select group_concat("name", ',') from
        (select "name" from pragma_index_info(${sqliteLiteral(name)}) order by "seqno")) = ${sqliteLiteral(columns)}
      then 1 else 0 end`,
  )
  const uniqueChecks = BETTER_AUTH_REQUIRED_UNIQUE_DDL.map(
    ([table, fragment]) =>
      `case when
      (select instr(${normalizedSchemaSql('"sql"')}, ${sqliteLiteral(fragment.toLowerCase())})
        from "sqlite_schema" where "type" = 'table' and "name" = ${sqliteLiteral(table)}) > 0
      then 1 else 0 end`,
  )
  const triggers = BETTER_AUTH_APPEND_ONLY_TRIGGERS.map(sqliteLiteral).join(", ")
  return `select ${tableChecks.join(", ")},
    (${indexChecks.join(" + ")}) as "requiredIndexDefinitionCount",
    (${uniqueChecks.join(" + ")}) as "requiredUniqueConstraintCount",
    (select count(*) from "sqlite_schema" where "type" = 'trigger' and "name" in (${triggers})) as "appendOnlyTriggerCount",
    (select count(*) from pragma_foreign_key_list('oauthAccessToken')
      where "from" = 'refreshId' and "table" = 'oauthRefreshToken' and "to" = 'id'
        and lower("on_delete") = 'cascade') as "refreshAccessCascadeCount",
    (select count(*) from pragma_foreign_key_list('authenticationEvidence')
      where ("from" = 'sessionId' and "table" = 'session' and "to" = 'id' and lower("on_delete") = 'cascade')
         or ("from" = 'subject' and "table" = 'user' and "to" = 'id' and lower("on_delete") = 'cascade'))
      as "authenticationEvidenceForeignKeyCount",
    ((select count(*) from pragma_foreign_key_list('deploymentCutoverCanaryAdmission')
      where "table" = 'deploymentRelease' and (("from" = 'deploymentId' and "to" = 'deploymentId')
        or ("from" = 'releaseId' and "to" = 'releaseId'))) +
     (select count(*) from pragma_foreign_key_list('deploymentCutoverEvidenceReceipt')
      where "table" = 'deploymentRelease' and (("from" = 'deploymentId' and "to" = 'deploymentId')
        or ("from" = 'releaseId' and "to" = 'releaseId'))))
      as "cutoverReleaseForeignKeyCount",
    (select count(*) from pragma_foreign_key_list('deploymentRecoveryEpoch')
      where "table" = 'deploymentRelease' and (("from" = 'deploymentId' and "to" = 'deploymentId')
        or ("from" = 'releaseId' and "to" = 'releaseId')))
      as "recoveryReleaseForeignKeyCount";`
}

type BetterAuthSchemaInspection = {
  requiredIndexDefinitionCount?: unknown
  requiredUniqueConstraintCount?: unknown
  appendOnlyTriggerCount?: unknown
  refreshAccessCascadeCount?: unknown
  authenticationEvidenceForeignKeyCount?: unknown
  cutoverReleaseForeignKeyCount?: unknown
  recoveryReleaseForeignKeyCount?: unknown
}

export function verifyBetterAuthDatabaseSchemaInspection(result: BetterAuthSchemaInspection | null) {
  if (
    result?.requiredIndexDefinitionCount !== BETTER_AUTH_REQUIRED_INDEXES.length ||
    result.requiredUniqueConstraintCount !== BETTER_AUTH_REQUIRED_UNIQUE_DDL.length ||
    result.appendOnlyTriggerCount !== BETTER_AUTH_APPEND_ONLY_TRIGGERS.length ||
    result.refreshAccessCascadeCount !== 1 ||
    result.authenticationEvidenceForeignKeyCount !== 2 ||
    result.cutoverReleaseForeignKeyCount !== 4 ||
    result.recoveryReleaseForeignKeyCount !== 2
  ) {
    throw new Error(
      `Better Auth database schema does not match the required structural contract: ${JSON.stringify(result)}`,
    )
  }
}

/** Fail readiness if the generated schema's tables, columns, indexes, cascade, or append-only triggers drift. */
export async function requireBetterAuthDatabaseSchema(database: D1Database) {
  const result = await database.prepare(betterAuthDatabaseSchemaInspectionSql()).first<BetterAuthSchemaInspection>()
  verifyBetterAuthDatabaseSchemaInspection(result)
}

export async function requireBetterAuthNativeClientClosure(
  database: D1Database,
  apiOrigin: string,
  betterAuthSecret: string,
  introspectionClientSecret: string,
) {
  const resource = betterAuthNativeResource(apiOrigin)
  const scopes = JSON.stringify(BETTER_AUTH_NATIVE_SCOPES)
  const checks = await Promise.all([
    database
      .prepare(
        `select count(*) as "count" from "oauthResource"
      where "id" = 'resource_control_plane' and "identifier" = ? and "name" = 'Claxedo control plane'
        and "accessTokenTtl" = 300 and "refreshTokenTtl" = 2592000 and "allowedScopes" = ?
        and "disabled" = 0 and "policyVersion" = 1`,
      )
      .bind(resource, scopes)
      .first<{ count: number }>(),
    database
      .prepare(
        `select count(*) as "count" from "oauthClient"
      where "id" = 'client_cli' and "clientId" = ? and "disabled" = 0 and "skipConsent" = 0
        and "subjectType" = 'public' and "scopes" = ? and "redirectUris" = '[]'
        and "tokenEndpointAuthMethod" = 'none' and "applicationType" = 'native'
        and "grantTypes" = ? and "responseTypes" = '["code"]' and "requirePKCE" = 1`,
      )
      .bind(
        BETTER_AUTH_CLI_CLIENT_ID,
        scopes,
        JSON.stringify(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]),
      )
      .first<{ count: number }>(),
    database
      .prepare(
        `select count(*) as "count" from "oauthClient"
      where "id" = 'client_desktop' and "clientId" = ? and "disabled" = 0 and "skipConsent" = 0
        and "subjectType" = 'public' and "scopes" = ? and "redirectUris" = '["http://127.0.0.1/callback"]'
        and "tokenEndpointAuthMethod" = 'none' and "applicationType" = 'native'
        and "grantTypes" = '["authorization_code","refresh_token"]'
        and "responseTypes" = '["code"]' and "requirePKCE" = 1`,
      )
      .bind(BETTER_AUTH_DESKTOP_CLIENT_ID, scopes)
      .first<{ count: number }>(),
    database
      .prepare(
        `select "clientSecret" from "oauthClient"
      where "id" = 'client_control_plane' and "clientId" = ? and "disabled" = 0
        and "skipConsent" = 1 and "tokenEndpointAuthMethod" = 'client_secret_post'
        and "applicationType" = 'web' and "grantTypes" = '[]' and "responseTypes" = '[]' and "requirePKCE" = 0`,
      )
      .bind(BETTER_AUTH_INTROSPECTION_CLIENT_ID)
      .first<{ clientSecret: string }>(),
    database
      .prepare(
        `select count(*) as "count" from "oauthClientResource"
      where ("id" = 'client_resource_cli' and "clientId" = ? and "resourceId" = ?)
        or ("id" = 'client_resource_desktop' and "clientId" = ? and "resourceId" = ?)`,
      )
      .bind(BETTER_AUTH_CLI_CLIENT_ID, resource, BETTER_AUTH_DESKTOP_CLIENT_ID, resource)
      .first<{ count: number }>(),
    database
      .prepare(
        `select count(*) as "count" from "oauthClientResource"
      where "id" = 'client_resource_control_plane' and "clientId" = ? and "resourceId" = ?`,
      )
      .bind(BETTER_AUTH_INTROSPECTION_CLIENT_ID, resource)
      .first<{ count: number }>(),
  ])
  const confidentialClient = checks[3]
  let confidentialClientSecretMatches = false
  if (
    confidentialClient &&
    "clientSecret" in confidentialClient &&
    typeof confidentialClient.clientSecret === "string"
  ) {
    try {
      confidentialClientSecretMatches = constantTimeEqual(
        await symmetricDecrypt({ key: betterAuthSecret, data: confidentialClient.clientSecret }),
        introspectionClientSecret,
      )
    } catch {
      confidentialClientSecretMatches = false
    }
  }
  if (
    !confidentialClientSecretMatches ||
    checks.some((row, index) => index !== 3 && (!(row && "count" in row) || row.count !== (index === 4 ? 2 : 1)))
  ) {
    throw new Error("Better Auth native-client closure is incomplete or does not match the certified policy")
  }
  return resource
}
