import type { CloudflareKvNamespaceBinding } from "@claxedo/server-core/credentials/backends/cloudflare"
import type { SandboxDriver, SandboxLeaseStore } from "@claxedo/sandbox-manager"
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider"
import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import type { ControlPlaneAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { AuthAdapterDescriptor } from "@claxedo/server-core/platform/auth/authentication"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import { browserAuthHttpSecurity } from "@claxedo/server-core/platform/http/browser-auth-security"

import { createD1CoreAuthority, type D1CoreAuthorityBoundary } from "../d1/core-authority"
import { USER_DEPLOYED_OWNER_CLAIM_HEADER, type D1AuthorityProductPolicy } from "../d1/workspace-authority"
import { createD1UserHostedTargetResolver } from "../d1/user-hosted-relay-target"
import { HostedWorkerCompositionError } from "../../composition-error"
import {
  composeProviderNeutralHostedControlPlane,
  type HostedControlPlane,
  type HostedWorkerEnv,
} from "../../provider-neutral-hosted-services"
import { D1ServiceInstallationStore } from "../../../platform/services/adapters/d1-installation-store"
import {
  BETTER_AUTH_NATIVE_SCOPES,
  BETTER_AUTH_SESSION_COOKIE,
  betterAuthIssuer,
  betterAuthNativeRevocation,
  createBetterAuthD1Foundation,
} from "../../../platform/auth/better-auth-d1-foundation"
import {
  resolveBetterAuthConfiguration,
  type AuthEmailSender,
  type BetterAuthConfiguration,
} from "../../../platform/auth/better-auth-configuration"
import {
  BETTER_AUTH_CLI_CLIENT_ID,
  BETTER_AUTH_DESKTOP_CLIENT_ID,
  BETTER_AUTH_INTROSPECTION_CLIENT_ID,
  betterAuthNativeResource,
} from "../../../platform/auth/better-auth-native-clients"
import { createBetterAuthD1AuthenticationEvidenceResolver } from "../../../platform/auth/better-auth-d1-authentication-evidence"
import { createBetterAuthD1RequestAuthenticationAdapter } from "../../../platform/auth/better-auth-d1-request-authentication"
import { STATIC_PRODUCT_DESCRIPTORS } from "../../../deployments/hosted-shared/deployment-profile"
import type { HostedCoreAppOptions } from "../../../deployments/hosted-shared/hosted-core-app"

type BetterAuthD1AuthorityEnv = {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1"
  CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted" | "user-deployed"
  CLAXEDO_DEPLOYMENT_ID: string
  CONTROL_PLANE_DB: D1Database
}

/** Compose the D1 implementation of the complete application authority port. */
export function composeBetterAuthD1Authority(input: {
  env: BetterAuthD1AuthorityEnv
  product: D1AuthorityProductPolicy
}): D1CoreAuthorityBoundary {
  if (input.env.CLAXEDO_ADAPTER_PROFILE !== "better-auth-d1") {
    throw new HostedWorkerCompositionError(
      "adapter_profile_mismatch",
      "Better Auth + D1 authority requires the better-auth-d1 adapter profile",
    )
  }
  if (input.env.CLAXEDO_PRODUCT_POSTURE !== input.product.kind) {
    throw new HostedWorkerCompositionError(
      "product_posture_mismatch",
      "D1 authority product policy must match the statically selected Worker product",
    )
  }
  if (
    input.product.kind === "user-deployed" &&
    input.product.ownerIdentity &&
    input.product.ownerIdentity.adapter !== "better-auth"
  ) {
    throw new HostedWorkerCompositionError(
      "product_identity_adapter_mismatch",
      "A Better Auth + D1 user-deployed owner identity must be owned by the Better Auth adapter",
    )
  }
  return createD1CoreAuthority(requiredDatabase(input.env.CONTROL_PLANE_DB), {
    deploymentId: required(input.env.CLAXEDO_DEPLOYMENT_ID, "CLAXEDO_DEPLOYMENT_ID"),
    product: input.product,
  })
}

export type BetterAuthD1UserDeployedCompositionInput = {
  env: HostedWorkerEnv
  authDatabase: D1Database
  controlPlaneDatabase: D1Database
  environmentId: string
  descriptorExpiresAt: number
  product: Extract<D1AuthorityProductPolicy, { kind: "user-deployed" }>
  emailSender?: AuthEmailSender
  now?: () => number
  /** Bound by feature entries that enable the hosted credential store (Agent Plugins). */
  credentialsNamespace?: CloudflareKvNamespaceBinding
  /**
   * The full-hosted entry's sandbox driver and durable lease store. Present
   * exactly when `CLAXEDO_SANDBOX_POSTURE=full-hosted`; the composition refuses
   * every other combination so a deployment never half-promises cloud VMs.
   */
  sandbox?: { driver: SandboxDriver; leaseStore: SandboxLeaseStore }
}

export type BetterAuthD1UserDeployedComposition = {
  plane: HostedControlPlane
  options: Omit<HostedCoreAppOptions, "liveSyncRoom" | "sharedRateLimitStore">
  /** Better Auth owns browser and native protocol routes plus AUTH_DB state. */
  authHandler(request: Request): Promise<Response>
  verifyIdentity(request: Request): Promise<AuthIdentity>
  /**
   * Settles when Better Auth's async initialization completes. A Worker must
   * not REUSE this composition across requests before then: the promise is
   * born on the constructing request's I/O context, and workerd retires that
   * context with the request, so a canceled constructor request would leave
   * every later caller awaiting it forever (see settled-composition-cache.ts).
   */
  authReady: Promise<void>
  serviceInstallations: D1ServiceInstallationStore
  product: (typeof STATIC_PRODUCT_DESCRIPTORS)["user-deployed"]
  billing: "absent"
}

/**
 * Certified user-deployed Better Auth + D1 selection. No hosted-provider fallback
 * exists. Full-hosted remains unavailable until D1 has a durable sandbox lease
 * store; the supported control-plane-only path contains no sandbox provider.
 */
/** A session token no sign-in can mint: the readiness read must never match a row. */
const COMPOSITION_READINESS_TOKEN = "claxedo.composition-readiness"

export function composeBetterAuthD1UserDeployedControlPlane(
  input: BetterAuthD1UserDeployedCompositionInput,
): BetterAuthD1UserDeployedComposition {
  if (input.authDatabase === input.controlPlaneDatabase) {
    throw new HostedWorkerCompositionError(
      "database_binding_reuse",
      "AUTH_DB and CONTROL_PLANE_DB must be distinct D1 bindings",
    )
  }
  const deploymentId = required(input.env.CLAXEDO_DEPLOYMENT_ID, "CLAXEDO_DEPLOYMENT_ID")
  const environmentId = required(input.environmentId, "environmentId")
  requireProfile(input.env, input.sandbox)
  const configured = resolveBetterAuthConfiguration({
    env: input.env,
    ...(input.emailSender ? { emailSender: input.emailSender } : {}),
  })
  const descriptor = betterAuthDescriptor(input, configured, deploymentId)
  if (input.product.ownerIdentity && input.product.ownerIdentity.issuer !== descriptor.issuer) {
    throw new HostedWorkerCompositionError(
      "product_identity_issuer_mismatch",
      "The pinned user-deployed owner identity issuer must match the selected Better Auth issuer",
    )
  }
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_DEPLOYMENT_ID: deploymentId,
      CONTROL_PLANE_DB: input.controlPlaneDatabase,
    },
    product: input.product,
  })
  const foundation = createBetterAuthD1Foundation({
    database: requiredDatabase(input.authDatabase),
    configuration: configured,
    resource: betterAuthNativeResource(configured.public.apiOrigin),
  })
  const authProtocol = new Hono()
  authProtocol.use(browserAuthHttpSecurity(descriptor.browser))
  authProtocol.all("*", (context) => {
    if (context.req.path === "/.well-known/oauth-authorization-server") {
      return oauthProviderAuthServerMetadata(foundation)(context.req.raw)
    }
    return foundation.handler(context.req.raw)
  })
  const authentication = createBetterAuthD1RequestAuthenticationAdapter({
    descriptor,
    auth: foundation,
    nativeIntrospectionClient: {
      clientId: BETTER_AUTH_INTROSPECTION_CLIENT_ID,
      clientSecret: introspectionSecret(input.env, configured),
    },
    resolveAuthenticationEvidence: createBetterAuthD1AuthenticationEvidenceResolver(input.authDatabase),
    resolveIdentity: async (identity, request) => {
      const existing = await authority.ensureApplicationIdentity(identity)
      if (existing.state !== "unavailable" || input.product.ownerBootstrap !== "one-use-claim") return existing
      const claim = request?.headers.get(USER_DEPLOYED_OWNER_CLAIM_HEADER)
      if (!claim) return existing
      return await authority.claimUserDeployedOwner(identity, claim)
    },
    ...(input.now ? { now: input.now } : {}),
  })
  const serviceInstallations = new D1ServiceInstallationStore(input.controlPlaneDatabase)
  const serviceCatalog = async () => {
    const installations = await serviceInstallations.list({ environmentId, deploymentId })
    const enabled = installations.filter((row) => row.descriptor.state === "enabled")
    if (enabled.length) {
      throw new HostedWorkerCompositionError(
        "hosted_capability_unavailable",
        `Base user-deployed core has enabled service installation(s) without bindings: ${enabled
          .map((row) => row.descriptor.serviceId)
          .join(", ")}`,
      )
    }
    return []
  }
  const legacyAuthBoundary: ControlPlaneAuthAdapter = {
    config: {
      enabled: true,
      adapter: "better-auth",
      issuer: descriptor.issuer,
      jwksUrl: `request-adapter:${encodeURIComponent(descriptor.configurationVersion)}`,
    },
  }
  const plane = composeProviderNeutralHostedControlPlane(input.env, {
    auth: legacyAuthBoundary,
    authority,
    runtimeSessionAuthority: authority,
    privateSessionAuthority: authority,
    turnAuthority: authority,
    ...(input.credentialsNamespace ? { credentialsNamespace: input.credentialsNamespace } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    userHostedResolver: createD1UserHostedTargetResolver(input.controlPlaneDatabase, {
      ...(input.now ? { now: input.now } : {}),
      deploymentId,
    }),
  })

  return {
    plane,
    options: {
      authentication,
      serviceCatalog,
      // User-deployed has no billing tier: with a composed sandbox the owner's
      // organization is entitled to cloud workspaces; without one the answer
      // names the posture instead of a 404.
      cloudWorkspaceAdmission: input.sandbox
        ? async () => undefined
        : async () => ({
            status: 403,
            body: {
              error: {
                code: "cloud_workspace_capability_unavailable",
                message: "This user-deployed control-plane-only profile does not provide cloud workspace execution",
              },
            },
          }),
      product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
      requestGuardExemptions: [],
      userDeployedIdentityAdmission: {
        admit: (auth, admission) => authority.admitUserDeployedIdentity(auth, admission),
      },
    },
    verifyIdentity: (request) => authentication.verifyIdentity(request),
    authHandler: async (request) => await authProtocol.fetch(request),
    authReady: foundation.$context.then(async (context) => {
      // Settled means both databases have answered THROUGH this composition.
      // The first auth-database read happens on whichever request first
      // carries a signed cookie, and the first control-plane read on the
      // first hosted route; a cancellation there would otherwise leave a
      // reusable composition whose adapter path never settles.
      await context.adapter.findOne({ model: "session", where: [{ field: "token", value: COMPOSITION_READINESS_TOKEN }] })
      await input.controlPlaneDatabase.prepare("select 1").first()
    }),
    serviceInstallations,
    product: STATIC_PRODUCT_DESCRIPTORS["user-deployed"],
    billing: "absent",
  }
}

function betterAuthDescriptor(
  input: BetterAuthD1UserDeployedCompositionInput,
  configured: BetterAuthConfiguration,
  deploymentId: string,
) {
  const now = input.now ?? Date.now
  if (!Number.isFinite(input.descriptorExpiresAt) || input.descriptorExpiresAt <= now()) {
    throw new HostedWorkerCompositionError(
      "auth_descriptor_invalid",
      "Better Auth descriptorExpiresAt must be a future finite timestamp",
    )
  }
  const configurationVersion = required(input.env.CLAXEDO_AUTH_CONFIGURATION_ID, "CLAXEDO_AUTH_CONFIGURATION_ID")
  const resource = betterAuthNativeResource(configured.public.apiOrigin)
  return {
    adapter: "better-auth",
    deploymentId,
    configurationVersion,
    expiresAt: input.descriptorExpiresAt,
    issuer: betterAuthIssuer(configured.public.apiOrigin),
    methods: configured.public.methods,
    browser: {
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      trustedOrigins: configured.public.trustedOrigins,
      clientId: "claxedo-browser",
      resource,
      scopes: ["workspace:read", "workspace:write"],
      cookie: {
        name: BETTER_AUTH_SESSION_COOKIE,
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: "lax",
      },
    },
    native: {
      cli: {
        flow: "device-authorization",
        clientId: BETTER_AUTH_CLI_CLIENT_ID,
        resource,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: configured.public.apiOrigin,
        controlPlaneOrigin: configured.public.apiOrigin,
        revocation: betterAuthNativeRevocation(configured.public.apiOrigin),
      },
      desktop: {
        flow: "authorization-code-pkce",
        clientId: BETTER_AUTH_DESKTOP_CLIENT_ID,
        resource,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: configured.public.apiOrigin,
        controlPlaneOrigin: configured.public.apiOrigin,
        revocation: betterAuthNativeRevocation(configured.public.apiOrigin),
      },
    },
  } as const satisfies AuthAdapterDescriptor
}

function requireProfile(env: HostedWorkerEnv, sandbox: BetterAuthD1UserDeployedCompositionInput["sandbox"]) {
  if (env.CLAXEDO_ADAPTER_PROFILE !== "better-auth-d1") {
    throw new HostedWorkerCompositionError(
      "adapter_profile_mismatch",
      "Better Auth + D1 composition requires CLAXEDO_ADAPTER_PROFILE=better-auth-d1",
    )
  }
  if (env.CLAXEDO_PRODUCT_POSTURE !== "user-deployed") {
    throw new HostedWorkerCompositionError(
      "product_posture_mismatch",
      "User-deployed Better Auth + D1 composition requires CLAXEDO_PRODUCT_POSTURE=user-deployed",
    )
  }
  const posture = env.CLAXEDO_SANDBOX_POSTURE
  const selectedDriver = env.CLAXEDO_SANDBOX_DRIVER?.trim()
  if (posture === "control-plane-only") {
    if (selectedDriver || sandbox) {
      throw new HostedWorkerCompositionError(
        "sandbox_posture_unsupported",
        "control-plane-only Better Auth + D1 must not configure CLAXEDO_SANDBOX_DRIVER or inject a sandbox",
      )
    }
    return
  }
  if (posture === "full-hosted") {
    // The lease store lives in CONTROL_PLANE_DB (sandbox/stores/d1.ts); the
    // driver is the full-hosted entry's, selected by the same variable the
    // provider-neutral plane checks it against.
    if (!selectedDriver || !sandbox || sandbox.driver.id !== selectedDriver) {
      throw new HostedWorkerCompositionError(
        "sandbox_posture_unsupported",
        "full-hosted Better Auth + D1 requires CLAXEDO_SANDBOX_DRIVER and a composed sandbox driver of that id with its D1 lease store",
      )
    }
    return
  }
  throw new HostedWorkerCompositionError(
    "sandbox_posture_unsupported",
    "Better Auth + D1 supports CLAXEDO_SANDBOX_POSTURE control-plane-only or full-hosted",
  )
}

function introspectionSecret(env: HostedWorkerEnv, configured: BetterAuthConfiguration) {
  const secret = required(env.CLAXEDO_AUTH_INTROSPECTION_SECRET, "CLAXEDO_AUTH_INTROSPECTION_SECRET")
  if (secret.length < 32) {
    throw new HostedWorkerCompositionError(
      "hosted_dependency_invalid",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET must contain at least 32 characters",
    )
  }
  if (secret === configured.private.secret) {
    throw new HostedWorkerCompositionError(
      "hosted_token_reuse",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET must be distinct from BETTER_AUTH_SECRET",
    )
  }
  if (secret === env.CLAXEDO_RELAY_RESOLVER_TOKEN?.trim()) {
    throw new HostedWorkerCompositionError(
      "hosted_token_reuse",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET must be distinct from CLAXEDO_RELAY_RESOLVER_TOKEN",
    )
  }
  return secret
}

function requiredDatabase(value: D1Database) {
  if (!value || typeof value.prepare !== "function" || typeof value.batch !== "function") {
    throw new HostedWorkerCompositionError("hosted_dependency_missing", "D1 database binding is required")
  }
  return value
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) throw new HostedWorkerCompositionError("hosted_dependency_missing", `${name} is required`)
  return normalized
}
