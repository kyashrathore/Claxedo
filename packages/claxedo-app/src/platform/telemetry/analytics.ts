let initialized = false
let ready = false
let posthog: typeof import("posthog-js").default | undefined
let posthogp: Promise<typeof import("posthog-js").default | undefined> | undefined
const queue: Array<(client: typeof import("posthog-js").default) => void> = []

/**
 * Which deployment the running build belongs to. Carried on every product-plane
 * event so per-user metrics can be read per plane; the ops plane never sets it.
 */
export type DeploymentMode = "cloud" | "self-host" | "desktop-local"

/**
 * The product surface an event was emitted from. Tight by construction: a new
 * surface must be added here before it can be captured.
 *
 * The last three entries are the onboarding funnel's own `surface` property
 * (`features/onboarding/funnel.ts` `step_done`), which travels under this key
 * and overrides the funnel adapter's "onboarding" default.
 */
export type Surface =
  | "app_shell"
  | "command_palette"
  | "composer"
  | "session"
  | "documents"
  | "processes"
  | "settings"
  | "workspaces"
  | "onboarding"
  | "error_page"
  | "error_page_harness"
  | "desktop"
  | "web"
  | "self-host"

/**
 * Required properties on every product-plane event. The index signature keeps
 * event-specific properties open; the four named keys are not optional, so a
 * call site that omits one fails the build.
 */
export type ProductEventProperties = {
  org_id: string
  user_id: string
  surface: Surface
  deployment_mode: DeploymentMode
  [key: string]: unknown
}

/** Stand-in for events emitted before auth resolves. Never a real identifier. */
export const ANONYMOUS_ID = "anon"

let identityUserId = ANONYMOUS_ID
let identityOrgId = ANONYMOUS_ID
// Conservative default until the shell resolves the real plane: an unresolved
// build is treated as self-host, the plane with the strictest posture.
let deployment: DeploymentMode = "self-host"

function loadPostHog() {
  if (import.meta.env.DEV) return Promise.resolve(undefined)
  if (posthog) return Promise.resolve(posthog)
  return (posthogp ??= import("posthog-js").then((mod) => {
    posthog = mod.default
    return posthog
  }))
}

function flush() {
  if (!ready || !posthog || queue.length === 0) return
  const next = queue.splice(0)
  for (const run of next) run(posthog)
}

function enqueue(run: (client: typeof import("posthog-js").default) => void) {
  if (!initialized) return
  if (ready && posthog) {
    run(posthog)
    return
  }
  queue.push(run)
}

export function initPostHog() {
  // Never send analytics from dev builds
  if (import.meta.env.DEV) return
  const key = import.meta.env.VITE_POSTHOG_KEY
  if (!key || initialized) return
  initialized = true
  void loadPostHog().then((client) => {
    if (!client) return
    client.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false,
      // Replaces Sentry: automatically captures unhandled exceptions and
      // promise rejections, visible under PostHog → Error Tracking
      capture_exceptions: true,
    })
    ready = true
    flush()
  })
}

/**
 * Resolve the deployment plane from the two signals the app already has.
 * `authEnabled` (VITE_AUTH_ENABLED) is the cloud discriminator — Claxedo Cloud
 * runs Clerk + Convex, a self-hosted build does not. Independent of the
 * onboarding `surface` derivation, which conflates desktop with hosted.
 */
export function resolveDeploymentMode(input: {
  platform: "web" | "desktop"
  authEnabled: boolean
}): DeploymentMode {
  if (input.platform === "desktop") return "desktop-local"
  return input.authEnabled ? "cloud" : "self-host"
}

export function setDeploymentMode(mode: DeploymentMode) {
  deployment = mode
}

export function deploymentMode(): DeploymentMode {
  return deployment
}

/**
 * The identity half of every product-plane payload. Spread it first so the
 * event's own properties stay authoritative:
 * `capture(name, { ...identityProps(), surface: "…", … })`.
 */
export function identityProps(): {
  org_id: string
  user_id: string
  deployment_mode: DeploymentMode
} {
  return { org_id: identityOrgId, user_id: identityUserId, deployment_mode: deployment }
}

/**
 * Bind the distinct id to the signed-in user. `person_profiles:
 * "identified_only"` produces no person record without this, so every per-user
 * metric depends on it.
 */
export function identify(userId: string, set?: Record<string, unknown>) {
  identityUserId = userId
  enqueue((client) => client.identify(userId, set))
}

/**
 * Attach the event stream to a group. Only the "org" type feeds `org_id`; any
 * other group type is forwarded but does not change the identity properties.
 */
export function group(groupType: string, groupKey: string, set?: Record<string, unknown>) {
  if (groupType === "org") identityOrgId = groupKey
  enqueue((client) => client.group(groupType, groupKey, set))
}

/** Drop the identity on sign-out so the next session starts anonymous. */
export function reset() {
  identityUserId = ANONYMOUS_ID
  identityOrgId = ANONYMOUS_ID
  enqueue((client) => client.reset())
}

export function capture(event: string, properties: ProductEventProperties) {
  enqueue((client) => client.capture(event, properties))
}

/**
 * Handled-boundary exceptions. Unhandled ones already arrive via
 * `capture_exceptions`; this covers errors an ErrorBoundary swallowed.
 */
export function captureException(error: unknown, properties?: ProductEventProperties) {
  enqueue((client) => client.captureException(error, properties))
}
