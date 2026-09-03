import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828020954_canonical_account_user",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`account\` ADD \`user_id\` text;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text,
          \`user_id\` text,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`auth_adapter\` text,
          \`auth_deployment_id\` text,
          \`auth_configuration_version\` text,
          \`auth_issuer\` text,
          \`auth_token_endpoint_origin\` text,
          \`auth_control_plane_origin\` text,
          \`auth_client_id\` text,
          \`auth_resource\` text,
          \`auth_scopes\` text,
          \`auth_token_kind\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_account\`(\`id\`, \`email\`, \`url\`, \`access_token\`, \`refresh_token\`, \`token_expiry\`, \`auth_adapter\`, \`auth_deployment_id\`, \`auth_configuration_version\`, \`auth_issuer\`, \`auth_token_endpoint_origin\`, \`auth_control_plane_origin\`, \`auth_client_id\`, \`auth_resource\`, \`auth_scopes\`, \`auth_token_kind\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`email\`, \`url\`, \`access_token\`, \`refresh_token\`, \`token_expiry\`, \`auth_adapter\`, \`auth_deployment_id\`, \`auth_configuration_version\`, \`auth_issuer\`, \`auth_token_endpoint_origin\`, \`auth_control_plane_origin\`, \`auth_client_id\`, \`auth_resource\`, \`auth_scopes\`, \`auth_token_kind\`, \`time_created\`, \`time_updated\` FROM \`account\`;`,
      )
      yield* tx.run(`DROP TABLE \`account\`;`)
      yield* tx.run(`ALTER TABLE \`__new_account\` RENAME TO \`account\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
} satisfies DatabaseMigration.Migration
