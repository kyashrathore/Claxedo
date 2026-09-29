import { isRecordArray, parseJson, stringField } from "@claxedo/server-core/platform/json/index"

import {
  BETTER_AUTH_CLI_CLIENT_ID,
  BETTER_AUTH_DESKTOP_CLIENT_ID,
  BETTER_AUTH_INTROSPECTION_CLIENT_ID,
  betterAuthDatabaseSchemaInspectionSql,
  betterAuthIntrospectionClientSecretCiphertext,
  betterAuthNativeClientProvisioningStatements,
  betterAuthNativeResource,
  verifyBetterAuthDatabaseSchemaInspection,
} from "../../src/platform/auth/better-auth-native-clients"
import { d1Row } from "./d1-json"
import { runWrangler } from "./wrangler-cli"

const D1_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The UUID of the database named `name` in `wrangler d1 list --json` output, if the account has one. */
export function d1DatabaseIdByName(listOutput: string, name: string) {
  const databases = parseJson(listOutput)
  if (!isRecordArray(databases)) throw new Error("wrangler d1 list did not return an array of databases")
  const matching = databases.filter((database) => stringField(database, "name") === name)
  if (matching.length === 0) return undefined
  const id = stringField(matching[0], "uuid")
  if (matching.length !== 1 || !id || !D1_UUID.test(id)) throw new Error(`D1 database ${name} has no single UUID`)
  return id
}

/** Find the database by name, creating it on the first deploy. */
export async function ensureD1Database(name: string) {
  const list = () => runWrangler(["d1", "list", "--json"], { capture: true })
  const existing = d1DatabaseIdByName(await list(), name)
  if (existing) return { id: existing, created: false }
  await runWrangler(["d1", "create", name])
  const created = d1DatabaseIdByName(await list(), name)
  if (!created) throw new Error(`wrangler d1 create ${name} did not produce a listed database`)
  return { id: created, created: true }
}

/**
 * The one SQL statement that proves the native OAuth clients this deploy
 * provisioned are in place: the CLI and desktop public clients, the Worker's
 * introspection client, and all three linked to the control-plane resource.
 */
export function nativeClientVerificationSql(apiOrigin: string) {
  const resource = betterAuthNativeResource(apiOrigin).replaceAll("'", "''")
  const clients = [BETTER_AUTH_CLI_CLIENT_ID, BETTER_AUTH_DESKTOP_CLIENT_ID, BETTER_AUTH_INTROSPECTION_CLIENT_ID]
    .map((clientId) => `'${clientId.replaceAll("'", "''")}'`)
    .join(", ")
  return `select
    (select count(*) from "oauthClient" where "clientId" in (${clients}) and "disabled" = 0) as "clients",
    (select count(*) from "oauthResource" where "identifier" = '${resource}') as "resource",
    (select count(*) from "oauthClientResource" where "clientId" in (${clients}) and "resourceId" = '${resource}') as "links";`
}

export function verifyNativeClientProvisioning(output: string) {
  const row = d1Row(output, "native OAuth client verification")
  if (row.clients !== 3 || row.resource !== 1 || row.links !== 3) {
    throw new Error(`native OAuth clients are incomplete after provisioning: ${JSON.stringify(row)}`)
  }
}

/**
 * Forward-only schema for both databases, then the idempotent native OAuth
 * client upserts. Every step converges on a re-run, so an upgrade runs the
 * same sequence a first deploy does.
 */
export async function prepareD1Databases(input: {
  configArgs: readonly string[]
  apiOrigin: string
  betterAuthSecret: string
  introspectionSecret: string
}) {
  for (const binding of ["AUTH_DB", "CONTROL_PLANE_DB"]) {
    await runWrangler(["d1", "migrations", "apply", binding, "--remote", ...input.configArgs])
  }
  const execute = (sql: string, capture = false) =>
    runWrangler(
      ["d1", "execute", "AUTH_DB", "--remote", ...input.configArgs, "--command", sql, ...(capture ? ["--json"] : [])],
      { capture },
    )
  verifyBetterAuthDatabaseSchemaInspection(
    d1Row(await execute(betterAuthDatabaseSchemaInspectionSql(), true), "auth schema inspection"),
  )
  const ciphertext = await betterAuthIntrospectionClientSecretCiphertext(input.betterAuthSecret, input.introspectionSecret)
  for (const sql of betterAuthNativeClientProvisioningStatements(input.apiOrigin, ciphertext)) await execute(sql)
  verifyNativeClientProvisioning(await execute(nativeClientVerificationSql(input.apiOrigin), true))
}
