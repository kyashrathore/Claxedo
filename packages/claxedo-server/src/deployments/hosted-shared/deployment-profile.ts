/**
 * Static deployment identity for the hosted control-plane products.
 *
 * These values are build/deploy inputs. They are deliberately independent of
 * credentials: discovering a Clerk key, a Convex URL, or a sandbox token must
 * never select a product or adapter. Deployment tooling resolves this contract
 * once and hands the resulting descriptor to a thin composition entrypoint.
 */

export const CERTIFIED_ADAPTER_PROFILES = ["better-auth-d1", "clerk-convex"] as const
export const PRODUCT_POSTURES = ["claxedo-hosted", "user-deployed"] as const
export const SANDBOX_POSTURES = ["control-plane-only", "full-hosted"] as const
export const SANDBOX_DRIVERS = ["cloudflare", "daytona", "exe", "fetch"] as const

export type CertifiedAdapterProfile = (typeof CERTIFIED_ADAPTER_PROFILES)[number]
export type ProductPosture = (typeof PRODUCT_POSTURES)[number]
export type SandboxPosture = (typeof SANDBOX_POSTURES)[number]
export type SandboxDriver = (typeof SANDBOX_DRIVERS)[number]

export type StaticProductDescriptor =
  | Readonly<{
      productPosture: "claxedo-hosted"
      organizationPolicy: "multi-org"
      billing: "polar"
      multiplayer: true
    }>
  | Readonly<{
      productPosture: "user-deployed"
      organizationPolicy: "single-org"
      billing: "absent"
      multiplayer: true
    }>

/** Product roots import one of these constants; credentials never choose it. */
export const STATIC_PRODUCT_DESCRIPTORS = Object.freeze({
  "claxedo-hosted": Object.freeze({
    productPosture: "claxedo-hosted",
    organizationPolicy: "multi-org",
    billing: "polar",
    multiplayer: true,
  }),
  "user-deployed": Object.freeze({
    productPosture: "user-deployed",
    organizationPolicy: "single-org",
    billing: "absent",
    multiplayer: true,
  }),
}) satisfies Readonly<Record<ProductPosture, StaticProductDescriptor>>

export type DeploymentProfileInput = {
  adapterProfile?: unknown
  productPosture?: unknown
  sandboxPosture?: unknown
  sandboxDriver?: unknown
}

export type DeploymentProfileEnv = Record<string, string | undefined>

type CommonDeploymentProfile = {
  multiplayer: true
} & (
  | {
      adapterProfile: "better-auth-d1"
      authAdapter: "better-auth"
      controlPlaneAdapter: "d1"
    }
  | {
      adapterProfile: "clerk-convex"
      authAdapter: "clerk"
      controlPlaneAdapter: "convex"
    }
) &
  (
    | {
        sandboxPosture: "control-plane-only"
      }
    | {
        sandboxPosture: "full-hosted"
        sandboxDriver: SandboxDriver
      }
  )

export type DeploymentProfile = CommonDeploymentProfile &
  (
    | {
        productPosture: "claxedo-hosted"
        organizationPolicy: "multi-org"
        billing: "polar"
      }
    | {
        productPosture: "user-deployed"
        organizationPolicy: "single-org"
        billing: "absent"
        adapterProfile: "better-auth-d1"
        authAdapter: "better-auth"
        controlPlaneAdapter: "d1"
      }
  )

export class DeploymentProfileError extends Error {
  constructor(
    public readonly code:
      | "invalid_adapter_profile"
      | "invalid_product_posture"
      | "invalid_sandbox_posture"
      | "invalid_sandbox_driver"
      | "uncertified_profile",
    message: string,
  ) {
    super(message)
    this.name = "DeploymentProfileError"
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  code: DeploymentProfileError["code"],
  name: string,
): T[number] {
  if (typeof value === "string" && values.includes(value)) return value as T[number]
  const choices = values.map((choice) => `"${choice}"`).join(" or ")
  throw new DeploymentProfileError(code, `${name} must be ${choices}`)
}

/** Resolve only combinations that deployment workflows are required to prove. */
export function resolveDeploymentProfile(input: DeploymentProfileInput): DeploymentProfile {
  const adapterProfile = oneOf(
    input.adapterProfile,
    CERTIFIED_ADAPTER_PROFILES,
    "invalid_adapter_profile",
    "adapter profile",
  )
  const productPosture = oneOf(input.productPosture, PRODUCT_POSTURES, "invalid_product_posture", "product posture")
  const sandboxPosture = oneOf(input.sandboxPosture, SANDBOX_POSTURES, "invalid_sandbox_posture", "sandbox posture")

  if (productPosture === "user-deployed" && adapterProfile !== "better-auth-d1") {
    throw new DeploymentProfileError(
      "uncertified_profile",
      `${productPosture} + ${adapterProfile} is not a certified deployment profile`,
    )
  }

  const sandbox =
    sandboxPosture === "full-hosted"
      ? ({
          sandboxPosture,
          sandboxDriver:
            input.sandboxDriver === undefined
              ? (() => {
                  throw new DeploymentProfileError(
                    "invalid_sandbox_driver",
                    "full-hosted requires an explicit sandbox driver",
                  )
                })()
              : oneOf(input.sandboxDriver, SANDBOX_DRIVERS, "invalid_sandbox_driver", "full-hosted sandbox driver"),
        } as const)
      : (() => {
          if (input.sandboxDriver !== undefined) {
            throw new DeploymentProfileError("invalid_sandbox_driver", "control-plane-only forbids a sandbox driver")
          }
          return { sandboxPosture } as const
        })()

  const adapters =
    adapterProfile === "better-auth-d1"
      ? ({
          adapterProfile,
          authAdapter: "better-auth",
          controlPlaneAdapter: "d1",
        } as const)
      : ({
          adapterProfile,
          authAdapter: "clerk",
          controlPlaneAdapter: "convex",
        } as const)

  const product = STATIC_PRODUCT_DESCRIPTORS[productPosture]

  return {
    ...adapters,
    ...product,
    ...sandbox,
    multiplayer: true,
  } as DeploymentProfile
}

/**
 * Read the three independent deployment axes from their dedicated inputs.
 * Provider and driver credentials are intentionally not inspected here.
 */
export function resolveDeploymentProfileFromEnv(env: DeploymentProfileEnv): DeploymentProfile {
  return resolveDeploymentProfile({
    adapterProfile: env.CLAXEDO_ADAPTER_PROFILE,
    productPosture: env.CLAXEDO_PRODUCT_POSTURE,
    sandboxPosture: env.CLAXEDO_SANDBOX_POSTURE,
    sandboxDriver: env.CLAXEDO_SANDBOX_DRIVER,
  })
}
