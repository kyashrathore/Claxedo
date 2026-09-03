import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cache, Clock, Duration, Effect, Layer, Option, Schema, SchemaGetter, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { AccountRepo, type AccountRow } from "./repo"
import { normalizeServerUrl } from "./url"
import {
  type AccountError,
  AccessToken,
  AccountID,
  DeviceCode,
  Info,
  RefreshToken,
  AccountServiceError,
  AccountTransportError,
  Login,
  NativeLoginBinding,
  Org,
  OrgID,
  PollDenied,
  PollError,
  PollExpired,
  PollPending,
  type PollResult,
  PollSlow,
  PollSuccess,
  UserCode,
} from "./schema"
import {
  assertCredentialBinding,
  assertCredentialServer,
  authorizationUri,
  betterAuthDeviceEndpoint,
  betterAuthTokenEndpoint,
  credentialBindingFromRow,
  parseCliAuthDescriptor,
  persistedCredentialBinding,
  type CliAuthDescriptor,
  type NativeCredentialBinding,
} from "./native-auth"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  AccessToken,
  RefreshToken,
  DeviceCode,
  UserCode,
  Info,
  Org,
  OrgID,
  Login,
  PollSuccess,
  PollPending,
  PollSlow,
  PollExpired,
  PollDenied,
  PollError,
  PollResult,
} from "./schema"

export type AccountOrgs = {
  account: Info
  orgs: readonly Org[]
}

export type ActiveOrg = {
  account: Info
  org: Org
}

export type AccountRemoval = {
  remoteRevocation: "revoked" | "uncertain"
}

class RemoteConfig extends Schema.Class<RemoteConfig>("RemoteConfig")({
  config: Schema.Record(Schema.String, Schema.Json),
}) {}

const DurationFromSeconds = Schema.Number.pipe(
  Schema.decodeTo(Schema.Duration, {
    decode: SchemaGetter.transform((n) => Duration.seconds(n)),
    encode: SchemaGetter.transform((d) => Duration.toSeconds(d)),
  }),
)

class TokenRefresh extends Schema.Class<TokenRefresh>("TokenRefresh")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  expires_in: DurationFromSeconds,
}) {}

class DeviceAuth extends Schema.Class<DeviceAuth>("DeviceAuth")({
  device_code: DeviceCode,
  user_code: UserCode,
  verification_uri_complete: Schema.String,
  expires_in: DurationFromSeconds,
  interval: DurationFromSeconds,
}) {}

class DeviceTokenSuccess extends Schema.Class<DeviceTokenSuccess>("DeviceTokenSuccess")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  token_type: Schema.Literal("Bearer"),
  expires_in: DurationFromSeconds,
}) {}

class DeviceTokenError extends Schema.Class<DeviceTokenError>("DeviceTokenError")({
  error: Schema.String,
  error_description: Schema.String,
}) {
  toPollResult(): PollResult {
    if (this.error === "authorization_pending") return new PollPending()
    if (this.error === "slow_down") return new PollSlow()
    if (this.error === "expired_token") return new PollExpired()
    if (this.error === "access_denied") return new PollDenied()
    return new PollError({ cause: this.error })
  }
}

const DeviceToken = Schema.Union([DeviceTokenSuccess, DeviceTokenError])

class AuthProfile extends Schema.Class<AuthProfile>("AuthProfile")({
  user: Schema.Struct({ id: Schema.String }),
  organizations: Schema.Array(Org),
}) {}
const eagerRefreshThreshold = Duration.minutes(5)
const eagerRefreshThresholdMs = Duration.toMillis(eagerRefreshThreshold)

const isTokenFresh = (tokenExpiry: number | null, now: number) =>
  tokenExpiry != null && tokenExpiry > now + eagerRefreshThresholdMs

const mapAccountServiceError =
  (message = "Account service operation failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
    effect.pipe(Effect.mapError((cause) => accountErrorFromCause(cause, message)))

const accountErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly activeOrg: () => Effect.Effect<Option.Option<ActiveOrg>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly orgsByAccount: () => Effect.Effect<readonly AccountOrgs[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<AccountRemoval, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
  readonly orgs: (accountID: AccountID) => Effect.Effect<readonly Org[], AccountError>
  readonly config: (
    accountID: AccountID,
    orgID: OrgID,
  ) => Effect.Effect<Option.Option<Record<string, unknown>>, AccountError>
  readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountError>
  readonly login: (url: string) => Effect.Effect<Login, AccountError>
  readonly poll: (input: Login) => Effect.Effect<PollResult, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Account") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, AccountRepo.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const http = yield* HttpClient.HttpClient
    const httpRead = withTransientReadRetry(http)
    const httpOk = HttpClient.filterStatusOk(http)
    const httpReadOk = HttpClient.filterStatusOk(httpRead)

    const executeRead = (request: HttpClientRequest.HttpClientRequest) =>
      httpRead.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const executeReadOk = (request: HttpClientRequest.HttpClientRequest) =>
      httpReadOk.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const executeOk = (request: HttpClientRequest.HttpClientRequest) =>
      httpOk.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(request).pipe(mapAccountServiceError("HTTP request failed"))

    const descriptorError = (cause: unknown) =>
      new AccountServiceError({ message: "Authentication deployment metadata is invalid", cause })

    const validateDescriptor = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: descriptorError })

    const discoverDescriptor = Effect.fnUntraced(function* (server: string) {
      const response = yield* executeReadOk(
        HttpClientRequest.get(`${server}/api/claxedo/auth/descriptor`).pipe(HttpClientRequest.acceptJson),
      )
      const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
        mapAccountServiceError("Failed to decode authentication descriptor"),
      )
      const now = yield* Clock.currentTimeMillis
      return yield* validateDescriptor(() => parseCliAuthDescriptor(body, server, now))
    })

    const revokeRfc7009 = Effect.fnUntraced(function* (row: AccountRow, descriptor: CliAuthDescriptor) {
      if (descriptor.revocation.protocol !== "rfc7009") {
        return yield* Effect.fail(new AccountServiceError({ message: "RFC 7009 revocation contract is unavailable" }))
      }
      const response = yield* execute(
        HttpClientRequest.post(descriptor.revocation.endpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: descriptor.clientId,
            token: row.refresh_token,
            token_type_hint: "refresh_token",
          }),
        ),
      )
      if (response.status !== 200) {
        return yield* Effect.fail(new AccountServiceError({ message: "Remote credential revocation was not accepted" }))
      }
      return { remoteRevocation: "revoked" } as const
    })

    const revokeAdapterNative = Effect.fnUntraced(function* (_row: AccountRow, descriptor: CliAuthDescriptor) {
      if (descriptor.revocation.protocol !== "adapter-native") {
        return yield* Effect.fail(
          new AccountServiceError({ message: "Adapter-native revocation contract is unavailable" }),
        )
      }
      // The retained adapter has no certified public revocation request schema
      // yet. Do not guess one and never fall back to the RFC 7009 endpoint.
      return { remoteRevocation: "uncertain" } as const
    })

    const revokeRemoteCredential = Effect.fnUntraced(function* (row: AccountRow) {
      const stored = yield* validateDescriptor(() => credentialBindingFromRow(row))
      yield* validateDescriptor(() => assertCredentialServer(stored, row.url))
      const descriptor = yield* discoverDescriptor(row.url)
      yield* validateDescriptor(() => assertCredentialBinding(stored, descriptor))

      switch (descriptor.revocation.protocol) {
        case "rfc7009":
          return yield* revokeRfc7009(row, descriptor)
        case "adapter-native":
          return yield* revokeAdapterNative(row, descriptor)
      }
    })

    const refreshToken = Effect.fnUntraced(function* (row: AccountRow, descriptor: CliAuthDescriptor) {
      const now = yield* Clock.currentTimeMillis

      const response = yield* executeOk(
        HttpClientRequest.post(betterAuthTokenEndpoint(descriptor)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: row.refresh_token,
            client_id: descriptor.clientId,
            resource: descriptor.resource,
          }),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(TokenRefresh)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )

      const expiry = Option.some(now + Duration.toMillis(parsed.expires_in))

      yield* repo.persistToken({
        accountID: row.id,
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        expectedRefreshToken: row.refresh_token,
        expiry,
      })

      return parsed.access_token
    })

    const refreshTokenCache = yield* Cache.make<AccountID, AccessToken, AccountError>({
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: Duration.zero,
      lookup: Effect.fnUntraced(function* (accountID) {
        const maybeAccount = yield* repo.getRow(accountID)
        if (Option.isNone(maybeAccount)) {
          return yield* Effect.fail(new AccountServiceError({ message: "Account not found during token refresh" }))
        }

        const account = maybeAccount.value
        const now = yield* Clock.currentTimeMillis
        if (isTokenFresh(account.token_expiry, now)) {
          return account.access_token
        }

        const stored = yield* validateDescriptor(() => credentialBindingFromRow(account))
        yield* validateDescriptor(() => assertCredentialServer(stored, account.url))
        const descriptor = yield* discoverDescriptor(account.url)
        yield* validateDescriptor(() => assertCredentialBinding(stored, descriptor))
        return yield* refreshToken(account, descriptor)
      }),
    })

    const resolveToken = Effect.fnUntraced(function* (row: AccountRow) {
      const stored = yield* validateDescriptor(() => credentialBindingFromRow(row))
      yield* validateDescriptor(() => assertCredentialServer(stored, row.url))
      const descriptor = yield* discoverDescriptor(row.url)
      yield* validateDescriptor(() => assertCredentialBinding(stored, descriptor))
      const now = yield* Clock.currentTimeMillis
      if (isTokenFresh(row.token_expiry, now)) {
        return row.access_token
      }

      return yield* Cache.get(refreshTokenCache, row.id)
    })

    const resolveAccess = Effect.fnUntraced(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      if (Option.isNone(maybeAccount)) return Option.none()

      const account = maybeAccount.value
      const accessToken = yield* resolveToken(account)
      return Option.some({ account, accessToken })
    })

    const fetchProfile = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const response = yield* executeReadOk(
        HttpClientRequest.get(`${url}/api/claxedo/auth/profile`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      return yield* HttpClientResponse.schemaBodyJson(AuthProfile)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
    })

    const token = Effect.fn("Account.token")((accountID: AccountID) =>
      resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
    )

    const remove = Effect.fn("Account.remove")(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      const remote = Option.isSome(maybeAccount)
        ? yield* revokeRemoteCredential(maybeAccount.value).pipe(
            Effect.catchCause(() => Effect.succeed({ remoteRevocation: "uncertain" } as const)),
          )
        : ({ remoteRevocation: "uncertain" } as const)

      // Local logout is authoritative for this device and must not depend on
      // network availability or a mutable remote deployment descriptor.
      yield* repo.remove(accountID)
      return remote
    })

    const activeOrg = Effect.fn("Account.activeOrg")(function* () {
      const activeAccount = yield* repo.active()
      if (Option.isNone(activeAccount)) return Option.none<ActiveOrg>()

      const account = activeAccount.value
      if (!account.active_org_id) return Option.none<ActiveOrg>()

      const accountOrgs = yield* orgs(account.id)
      const org = accountOrgs.find((item) => item.id === account.active_org_id)
      if (!org) return Option.none<ActiveOrg>()

      return Option.some({ account, org })
    })

    const orgsByAccount = Effect.fn("Account.orgsByAccount")(function* () {
      const accounts = yield* repo.list()
      return yield* Effect.forEach(
        accounts,
        (account) =>
          orgs(account.id).pipe(
            Effect.catch(() => Effect.succeed([] as readonly Org[])),
            Effect.map((orgs) => ({ account, orgs })),
          ),
        { concurrency: 3 },
      )
    })

    const orgs = Effect.fn("Account.orgs")(function* (accountID: AccountID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return []

      const { account, accessToken } = resolved.value

      return (yield* fetchProfile(account.url, accessToken)).organizations
    })

    const config = Effect.fn("Account.config")(function* (accountID: AccountID, orgID: OrgID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return Option.none()

      const { account, accessToken } = resolved.value

      const response = yield* executeRead(
        HttpClientRequest.get(`${account.url}/api/config`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.setHeaders({ "x-org-id": orgID }),
        ),
      )

      if (response.status === 404) return Option.none()

      const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(mapAccountServiceError())

      const parsed = yield* HttpClientResponse.schemaBodyJson(RemoteConfig)(ok).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
      return Option.some(parsed.config)
    })

    const login = Effect.fn("Account.login")(function* (server: string) {
      const normalizedServer = normalizeServerUrl(server)
      const descriptor = yield* discoverDescriptor(normalizedServer)
      const response = yield* executeOk(
        HttpClientRequest.post(betterAuthDeviceEndpoint(descriptor)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams({
            client_id: descriptor.clientId,
            scope: descriptor.scopes.join(" "),
            resource: descriptor.resource,
          }),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceAuth)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )
      return new Login({
        code: parsed.device_code,
        user: parsed.user_code,
        url: yield* validateDescriptor(() => authorizationUri(parsed.verification_uri_complete, descriptor)),
        server: normalizedServer,
        expiry: parsed.expires_in,
        interval: parsed.interval,
        binding: new NativeLoginBinding({
          adapter: descriptor.adapter,
          deploymentId: descriptor.deploymentId,
          configurationVersion: descriptor.configurationVersion,
          descriptorExpiresAt: descriptor.expiresAt,
          issuer: descriptor.issuer,
          flow: descriptor.flow,
          tokenEndpointOrigin: descriptor.tokenEndpointOrigin,
          controlPlaneOrigin: descriptor.controlPlaneOrigin,
          clientId: descriptor.clientId,
          resource: descriptor.resource,
          scopes: [...descriptor.scopes],
          tokenKind: descriptor.tokenKind,
        }),
      })
    })

    const poll = Effect.fn("Account.poll")(function* (input: Login) {
      const loginBinding = {
        adapter: input.binding.adapter,
        deploymentId: input.binding.deploymentId,
        issuer: input.binding.issuer,
        tokenEndpointOrigin: input.binding.tokenEndpointOrigin,
        controlPlaneOrigin: input.binding.controlPlaneOrigin,
        clientId: input.binding.clientId,
        resource: input.binding.resource,
        scopes: input.binding.scopes,
        tokenKind: input.binding.tokenKind,
      } satisfies NativeCredentialBinding
      const response = yield* execute(
        HttpClientRequest.post(betterAuthTokenEndpoint(input.binding)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: input.code,
            client_id: input.binding.clientId,
            resource: input.binding.resource,
          }),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceToken)(response).pipe(
        mapAccountServiceError("Failed to decode response"),
      )

      if (parsed instanceof DeviceTokenError) return parsed.toPollResult()
      const accessToken = parsed.access_token

      // Re-read discovery before accepting a credential. A deployment that
      // changed while the browser approval was open cannot bind a token issued
      // under the old tuple to the new control plane.
      const descriptor = yield* discoverDescriptor(input.server)
      yield* validateDescriptor(() => assertCredentialBinding(loginBinding, descriptor))
      const profile = yield* fetchProfile(input.server, accessToken)

      // TODO: When there are multiple orgs, let the user choose
      const firstOrgID =
        profile.organizations.length > 0 ? Option.some(profile.organizations[0]!.id) : Option.none<OrgID>()

      const now = yield* Clock.currentTimeMillis
      const expiry = now + Duration.toMillis(parsed.expires_in)
      const refreshToken = parsed.refresh_token

      yield* repo.persistAccount({
        id: AccountID.make(`${descriptor.deploymentId}:${profile.user.id}`),
        userId: profile.user.id,
        url: input.server,
        accessToken,
        refreshToken,
        expiry,
        orgID: firstOrgID,
        binding: persistedCredentialBinding(descriptor),
      })

      return new PollSuccess({ userId: profile.user.id })
    })

    return Service.of({
      active: repo.active,
      activeOrg,
      list: repo.list,
      orgsByAccount,
      remove,
      use: repo.use,
      orgs,
      config,
      token,
      login,
      poll,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AccountRepo.node, httpClient] })

export * as Account from "./account"
