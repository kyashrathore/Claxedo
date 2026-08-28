import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828020559_native_auth_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_adapter\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_deployment_id\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_configuration_version\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_issuer\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_token_endpoint_origin\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_control_plane_origin\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_client_id\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_resource\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_scopes\` text;`)
      yield* tx.run(`ALTER TABLE \`account\` ADD \`auth_token_kind\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
