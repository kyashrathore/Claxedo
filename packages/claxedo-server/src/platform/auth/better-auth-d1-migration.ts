import type { BetterAuthOptions } from "better-auth"
import { getMigrations } from "better-auth/db/migration"

import { betterAuthD1FoundationOptions } from "./better-auth-d1-foundation"
import { resolveBetterAuthConfiguration } from "./better-auth-configuration"
import { betterAuthNativeResource } from "./better-auth-native-clients"

export const BETTER_AUTH_D1_MIGRATION_HEADER = `-- Generated from better-auth-d1-foundation.ts with the exact Better Auth 1.7.1
-- package set. Deployment tooling must apply this artifact before Worker start;
-- runtime Workers never introspect or migrate the live D1 binding.

`

export async function compileBetterAuthD1Migration(
  database: NonNullable<BetterAuthOptions["database"]>,
) {
  const apiOrigin = "https://api.claxedo.test"
  const configuration = resolveBetterAuthConfiguration({
    env: {
      CLAXEDO_AUTH_METHODS: "email-password",
      BETTER_AUTH_URL: apiOrigin,
      CLAXEDO_APP_ORIGIN: "https://app.claxedo.test",
      BETTER_AUTH_SECRET: "schema-generation-only-secret-that-is-never-deployed",
    },
    emailSender: { async send() {} },
  })
  const migrations = await getMigrations(betterAuthD1FoundationOptions({
    database,
    configuration,
    resource: betterAuthNativeResource(apiOrigin),
  }))
  return BETTER_AUTH_D1_MIGRATION_HEADER + await migrations.compileMigrations() + "\n"
}
