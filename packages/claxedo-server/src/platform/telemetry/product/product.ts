/**
 * Product-plane capture wrapper.
 *
 * Two telemetry planes with different contracts share one transport:
 *
 * - **Product plane** (this module): feature events, funnel steps, metering.
 *   `distinct_id = user_id`, `$groups.org = org_id`, and the four properties
 *   below are REQUIRED AT THE TYPE LEVEL. "Average X per user" and "which org
 *   hit this?" are uncomputable in principle if a single call site is allowed
 *   to omit them, so the compiler is the enforcement point — a call site
 *   missing any of the four fails the build.
 * - **Ops plane** (the host operational-telemetry modules and the other
 *   `distinct_id: "system"` monitors): bounded counts, durations, and status
 *   classes with NO org/user identifiers and no content. It keeps calling
 *   `ControlPlaneTelemetry.capture` directly and is exempt by construction.
 *
 * Worker-safe: the only dependency is a type. `authority/services.ts` must
 * never enter the Worker's runtime graph (it lazily reaches the fs-backed
 * credential registry), so the port arrives as `import type`.
 */

import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"

/**
 * Where the deployment sits, as the product plane reports it. Distinct from
 * `Trust`, which is a boot-time enforcement decision with only
 * two values — desktop builds are hosted-code running locally and must be
 * separable from Cloud in the funnel.
 */
export type ProductDeploymentMode = "cloud" | "self-host" | "desktop-local"

/** The four properties every product event carries. No optional members. */
export type ProductIdentity = {
  org_id: string
  user_id: string
  surface: string
  deployment_mode: ProductDeploymentMode
}

/** Structural: any ControlPlaneTelemetry satisfies it, and so does a test spy. */
export type ProductCaptureSink = Pick<ControlPlaneTelemetry, "capture">

export type ProductCaptureOptions = {
  /** Extra group keys. `org` is always set from `org_id` and cannot be overridden. */
  groups?: Record<string, string>
}

/**
 * Emit a product-plane event. Identity properties are applied LAST so a
 * caller's property bag can never shadow them.
 */
export function captureProduct(
  sink: ProductCaptureSink | undefined,
  event: string,
  identity: ProductIdentity,
  properties: Record<string, unknown> = {},
  options: ProductCaptureOptions = {},
): void {
  try {
    sink?.capture(identity.user_id, event, {
      ...properties,
      org_id: identity.org_id,
      user_id: identity.user_id,
      surface: identity.surface,
      deployment_mode: identity.deployment_mode,
      $groups: { ...options.groups, org: identity.org_id },
    })
  } catch {
    // Telemetry is evidence, never part of the transaction it observes.
  }
}

/**
 * Build an identity from a request's auth, or `undefined` when the org is
 * unknown. Org membership is optional on the token (personal-account sign-ins
 * carry no `org_id` claim), and a fabricated org id is worse than a missing
 * event: it silently corrupts every per-org aggregate. Call sites branch on
 * the `undefined` rather than substituting a placeholder.
 */
export function productIdentity(
  auth: { user: { subject: string; orgId?: string | undefined } } | undefined,
  context: { surface: string; deployment_mode: ProductDeploymentMode },
): ProductIdentity | undefined {
  const userId = auth?.user.subject?.trim()
  const orgId = auth?.user.orgId?.trim()
  if (!userId || !orgId) return undefined
  return {
    org_id: orgId,
    user_id: userId,
    surface: context.surface,
    deployment_mode: context.deployment_mode,
  }
}
