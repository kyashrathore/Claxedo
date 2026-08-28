import type { BetterAuthOptions } from "better-auth"
import { queueAfterTransactionHook } from "@better-auth/core/context"
import { betterAuth } from "better-auth/minimal"
import { jwt } from "better-auth/plugins"
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider"
import type { D1Database } from "@cloudflare/workers-types"

import { betterAuthD1Adapter } from "./better-auth-d1-adapter"
import { betterAuthD1AuthenticationEvidenceHooks } from "./better-auth-d1-authentication-evidence"
import type { BetterAuthConfiguration } from "./better-auth-configuration"
import {
  BETTER_AUTH_ACCESS_TOKEN_PREFIX,
  BETTER_AUTH_REFRESH_TOKEN_PREFIX,
  betterAuthOAuthTokenHash,
} from "./better-auth-token-hash"

export const BETTER_AUTH_SESSION_COOKIE = "__Secure-claxedo.session_token"
export const BETTER_AUTH_NATIVE_SCOPES = [
  "offline_access",
  "workspace:read",
  "workspace:write",
] as const

export function betterAuthIssuer(apiOrigin: string) {
  return `${apiOrigin}/api/auth`
}

export function betterAuthNativeRevocation(apiOrigin: string) {
  return {
    protocol: "rfc7009",
    endpoint: `${betterAuthIssuer(apiOrigin)}/oauth2/revoke`,
    tokenEndpointAuthMethod: "none",
  } as const
}

export type BetterAuthD1FoundationInput = {
  database: NonNullable<BetterAuthOptions["database"]>
  configuration: BetterAuthConfiguration
  resource: string
  databaseHooks?: BetterAuthOptions["databaseHooks"]
}

export type BetterAuthD1RuntimeInput = Omit<BetterAuthD1FoundationInput, "database"> & {
  database: D1Database
}

/**
 * Worker-safe Better Auth+D1 options used by both schema generation and the
 * Worker runtime. Migration tooling supplies SQLite only to compile the exact
 * schema; the deployed runtime supplies D1 and never introspects live schema.
 */
export function betterAuthD1FoundationOptions(input: BetterAuthD1FoundationInput) {
  const emailPasswordEnabled = input.configuration.public.methods.includes("email-password")
  const emailSender = input.configuration.private.emailSender
  if (emailPasswordEnabled && !emailSender) {
    throw new Error("email-password requires a deployment-owned AuthEmailSender")
  }
  return {
    database: input.database,
    baseURL: input.configuration.public.apiOrigin,
    secret: input.configuration.private.secret,
    trustedOrigins: [...input.configuration.public.trustedOrigins],
    socialProviders: input.configuration.private.socialProviders,
    emailAndPassword: emailPasswordEnabled
      ? {
          enabled: true,
          requireEmailVerification: true,
          autoSignIn: false,
          minPasswordLength: 12,
          revokeSessionsOnPasswordReset: true,
          sendResetPassword: async ({ user, url, token }) => queueAfterTransactionHook(() => emailSender!.send({
              kind: "password-reset",
              recipient: user.email,
              actionUrl: url,
              token,
            })),
        }
      : { enabled: false },
    ...(emailPasswordEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: false,
            sendVerificationEmail: async ({ user, url, token }: {
              user: { email: string }
              url: string
              token: string
            }) => queueAfterTransactionHook(() => emailSender!.send({
                kind: "verification",
                recipient: user.email,
                actionUrl: url,
                token,
              })),
          },
        }
      : {}),
    advanced: {
      useSecureCookies: true,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      cookiePrefix: "claxedo",
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },
    telemetry: { enabled: false },
    databaseHooks: input.databaseHooks,
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          issuer: betterAuthIssuer(input.configuration.public.apiOrigin),
          audience: input.resource,
          expirationTime: "5m",
        },
      }),
      oauthProvider({
        loginPage: `${input.configuration.public.appOrigin}/login`,
        consentPage: `${input.configuration.public.appOrigin}/oauth/consent`,
        scopes: [...BETTER_AUTH_NATIVE_SCOPES],
        resources: [
          {
            identifier: input.resource,
            allowedScopes: [...BETTER_AUTH_NATIVE_SCOPES],
            accessTokenTtl: 300,
          },
        ],
        clientRegistrationDefaultResources: [input.resource],
        allowPublicClientPrelogin: true,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        // Native access tokens are D1-backed opaque credentials. Better Auth's
        // resource JWTs are self-contained and cannot satisfy remote revoke.
        disableJwtPlugin: true,
        // With disableJwtPlugin, Better Auth signs ID tokens with the OAuth
        // client secret and therefore must be able to recover it. Its default
        // authenticated encryption is the only supported storage posture.
        storeClientSecret: "encrypted",
        storeTokens: { hash: betterAuthOAuthTokenHash },
        prefix: {
          opaqueAccessToken: BETTER_AUTH_ACCESS_TOKEN_PREFIX,
          refreshToken: BETTER_AUTH_REFRESH_TOKEN_PREFIX,
        },
        // Client provisioning belongs to deployment migrations/install tooling,
        // never to an arbitrary signed-in user.
        clientPrivileges: async () => false,
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        refreshTokenReuseInterval: 0,
        requireAtomicRefreshRotation: true,
      }),
      oauthDeviceAuthorization({
        verificationUri: `${input.configuration.public.appOrigin}/device`,
        expiresIn: "10m",
        interval: "5s",
      }),
    ],
  } satisfies BetterAuthOptions
}

export function createBetterAuthD1Foundation(input: BetterAuthD1RuntimeInput) {
  return betterAuth(betterAuthD1FoundationOptions({
    ...input,
    database: betterAuthD1Adapter(input.database),
    databaseHooks: betterAuthD1AuthenticationEvidenceHooks(input.database, input.databaseHooks),
  }))
}
