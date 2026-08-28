import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Layer, Option, Schema, Context } from "effect"

import { Database } from "@opencode-ai/core/database/database"
import { AccountStateTable, AccountTable } from "@opencode-ai/core/account/sql"
import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken } from "./schema"
import { normalizeServerUrl } from "./url"
import type { PersistedNativeCredentialBinding } from "./native-auth"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

const ACCOUNT_STATE_ID = 1

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
  readonly list: () => Effect.Effect<Info[], AccountRepoError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
  readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
  readonly persistToken: (input: {
    accountID: AccountID
    accessToken: AccessToken
    refreshToken: RefreshToken
    expectedRefreshToken: RefreshToken
    expiry: Option.Option<number>
  }) => Effect.Effect<void, AccountRepoError>
  readonly persistAccount: (input: {
    id: AccountID
    userId: string
    url: string
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: number
    orgID: Option.Option<OrgID>
    binding: PersistedNativeCredentialBinding
  }) => Effect.Effect<void, AccountRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AccountRepo") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Info)

    const query = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => cause instanceof AccountRepoError
        ? cause
        : new AccountRepoError({ message: "Database operation failed", cause })))

    const current = Effect.fnUntraced(function* () {
      const state = yield* db.select().from(AccountStateTable).where(eq(AccountStateTable.id, ACCOUNT_STATE_ID)).get()
      if (!state?.active_account_id) return
      const account = yield* db.select().from(AccountTable).where(eq(AccountTable.id, state.active_account_id)).get()
      if (!account?.user_id) return
      return { ...account, active_org_id: state.active_org_id ?? null }
    })

    const state = (accountID: AccountID, orgID: Option.Option<OrgID>) => {
      const id = Option.getOrNull(orgID)
      return db
        .insert(AccountStateTable)
        .values({ id: ACCOUNT_STATE_ID, active_account_id: accountID, active_org_id: id })
        .onConflictDoUpdate({
          target: AccountStateTable.id,
          set: { active_account_id: accountID, active_org_id: id },
        })
        .run()
    }

    const active = Effect.fn("AccountRepo.active")(() =>
      query(current()).pipe(Effect.map((row) => (row ? Option.some(decode(row)) : Option.none()))),
    )

    const list = Effect.fn("AccountRepo.list")(() =>
      query(
        db
          .select()
          .from(AccountTable)
          .where(isNotNull(AccountTable.user_id))
          .all()
          .pipe(Effect.map((rows) => rows.map((row: AccountRow) => decode({ ...row, active_org_id: null })))),
      ),
    )

    const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(AccountStateTable)
              .set({ active_account_id: null, active_org_id: null })
              .where(eq(AccountStateTable.active_account_id, accountID))
              .run()
            yield* tx.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
      query(state(accountID, orgID)).pipe(Effect.asVoid),
    )

    const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
      query(db.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    )

    const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(AccountTable)
              .set({
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: Option.getOrNull(input.expiry),
              })
              .where(and(
                eq(AccountTable.id, input.accountID),
                eq(AccountTable.refresh_token, input.expectedRefreshToken),
              ))
              .run()
            const result = yield* tx.get<{ changes: number }>(sql`select changes() as changes`)
            if (result?.changes !== 1) {
              return yield* Effect.fail(new AccountRepoError({
                message: "Native credential changed during refresh; refusing to overwrite the current generation",
              }))
            }
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const url = normalizeServerUrl(input.url)

            yield* tx
              .insert(AccountTable)
              .values({
                id: input.id,
                email: null,
                user_id: input.userId,
                url,
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: input.expiry,
                auth_adapter: input.binding.adapter,
                auth_deployment_id: input.binding.deploymentId,
                auth_configuration_version: input.binding.configurationVersion,
                auth_issuer: input.binding.issuer,
                auth_token_endpoint_origin: input.binding.tokenEndpointOrigin,
                auth_control_plane_origin: input.binding.controlPlaneOrigin,
                auth_client_id: input.binding.clientId,
                auth_resource: input.binding.resource,
                auth_scopes: JSON.stringify(input.binding.scopes),
                auth_token_kind: input.binding.tokenKind,
              })
              .onConflictDoUpdate({
                target: AccountTable.id,
                set: {
                  email: null,
                  user_id: input.userId,
                  url,
                  access_token: input.accessToken,
                  refresh_token: input.refreshToken,
                  token_expiry: input.expiry,
                  auth_adapter: input.binding.adapter,
                  auth_deployment_id: input.binding.deploymentId,
                  auth_configuration_version: input.binding.configurationVersion,
                  auth_issuer: input.binding.issuer,
                  auth_token_endpoint_origin: input.binding.tokenEndpointOrigin,
                  auth_control_plane_origin: input.binding.controlPlaneOrigin,
                  auth_client_id: input.binding.clientId,
                  auth_resource: input.binding.resource,
                  auth_scopes: JSON.stringify(input.binding.scopes),
                  auth_token_kind: input.binding.tokenKind,
                },
              })
              .run()
            yield* state(input.id, input.orgID)
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    return Service.of({
      active,
      list,
      remove,
      use,
      getRow,
      persistToken,
      persistAccount,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Database.node] })

export * as AccountRepo from "./repo"
