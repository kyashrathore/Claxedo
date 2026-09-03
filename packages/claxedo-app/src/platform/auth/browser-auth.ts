import type { Accessor } from "solid-js"
import type { AuthDisplayUser } from "./auth-display"

export const BROWSER_AUTH_ADAPTERS = ["better-auth"] as const
export const BROWSER_AUTH_METHODS = ["google", "github", "email-password"] as const

export type BrowserAuthAdapterId = (typeof BROWSER_AUTH_ADAPTERS)[number]
export type BrowserAuthMethod = (typeof BROWSER_AUTH_METHODS)[number]

export type BrowserAuthDescriptor = {
  adapter: BrowserAuthAdapterId
  deploymentId: string
  configurationVersion: string
  expiresAt: number
  issuer: string
  methods: readonly BrowserAuthMethod[]
  browser: {
    transport: "cookie" | "bearer"
    credentialPolicy: "reject-cookie-and-authorization" | "authorization-only"
    trustedOrigins: readonly string[]
    clientId: string
    resource: string
    scopes: readonly string[]
    cookie?: {
      name: string
      path: "/"
      secure: true
      httpOnly: true
      hostOnly: true
      sameSite: "lax" | "strict"
    }
  }
}

export type BrowserAuthSignInOptions =
  | { method?: undefined; redirectUrl?: string }
  | { method: "google" | "github"; redirectUrl?: string }
  | { method: "email-password"; email: string; password: string; redirectUrl?: string }

export type BrowserAuthSignUpOptions =
  | { method?: undefined; redirectUrl?: string }
  | { method: "google" | "github"; redirectUrl?: string }
  | { method: "email-password"; email: string; password: string; name?: string; redirectUrl?: string }

export type BrowserAuthState = {
  descriptor: Accessor<BrowserAuthDescriptor | null>
  methods: Accessor<readonly BrowserAuthMethod[]>
  session: Accessor<unknown>
  user: Accessor<AuthDisplayUser | null>
  loading: Accessor<boolean>
  isSignedIn: Accessor<boolean>
  signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  signOut: () => Promise<void>
  signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>
  refreshSession: () => Promise<void>
  organization: Accessor<{ id?: string } | null | undefined>
}

/**
 * The deployment an adapter is being started against.
 *
 * `centralTransport` is not re-derived here from `apiOrigin`: the composition
 * root reads it from `centralTransportForServer`, the same call `CloudAuthGate`
 * makes to decide whether a signed session is required at all, and hands the
 * answer down. One reading, one owner, and the gate and the adapter cannot
 * disagree about which deployment this is.
 */
export type BrowserAuthDeployment = {
  apiOrigin: string
  appOrigin: string
  centralTransport: "loopback" | "signed-web"
}

export type BrowserAuthAdapter = {
  readonly adapter: BrowserAuthAdapterId
  readonly transport: "cookie" | "bearer"
  readonly implementationMarker: string
  /**
   * Start signing in, reporting the outcome through `useAuth()`'s signals
   * rather than through this promise.
   *
   * It RESOLVES in every case, including every case in which nobody can be
   * signed in (`browserAuthUnavailable`, a failed descriptor, a provider SDK
   * that would not load). The composition root starts it before `render()` and
   * does not await it, so a rejection here would have nowhere to go but a
   * startup-failure panel — which is how a plain-http origin once replaced the
   * entire shell, `/login` included, with an error box.
   *
   * `loading` is true only while this call is in flight. An adapter nobody
   * initialized is therefore `anonymous` on its first read, never a session
   * that waits forever for a resolution that is not coming.
   */
  initialize(input: BrowserAuthDeployment): Promise<void>
  useAuth(): BrowserAuthState
  getToken(options?: { skipCache?: boolean }): Promise<string | null>
}

type DescriptorRequest = (input: string, init?: RequestInit) => Promise<Response>

export class BrowserAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserAuthConfigurationError"
  }
}

export function assertBrowserAuthDescriptorBinding(expected: BrowserAuthDescriptor, live: BrowserAuthDescriptor) {
  if (
    live.adapter !== expected.adapter ||
    live.deploymentId !== expected.deploymentId ||
    live.configurationVersion !== expected.configurationVersion
  ) {
    throw new BrowserAuthConfigurationError("live browser auth configuration binding changed")
  }
}

/**
 * Why this deployment has no browser sign-in flow at all, or null when it has
 * one. Two answers, both of them normal deployments rather than failures:
 *
 *  - A loopback central plane authenticates by loopback. It has no accounts,
 *    so there is nothing to ask it — no descriptor request, no provider SDK.
 *  - Any non-HTTPS origin: a self-host on `http://host.lan:3001`, the dev
 *    server, an e2e preview. `loadBrowserAuthDescriptor` below is HTTPS-only,
 *    so the flow cannot start.
 *
 * A REASON and not an exception, because an adapter has to keep working after
 * it: the shell still renders, `useAuthSession().status()` is `anonymous`
 * immediately, and a sign-in attempt refuses with this sentence.
 *
 * Deliberately NOT a startup failure. A build that cannot sign anyone in is
 * still a usable app, and painting an error panel instead of the shell means
 * the sign-in surfaces the user came for never render at all.
 *
 * Consulted AFTER an adapter's own test-auth bypass: the e2e harness injects a
 * principal directly and never reaches a deployment, so "this deployment has
 * no sign-in flow" has nothing to say about it.
 */
export function browserAuthUnavailable(deployment: BrowserAuthDeployment): string | null {
  if (deployment.centralTransport === "loopback") {
    return "Sign-in is unavailable: this app talks to a loopback Claxedo server, which has no accounts."
  }
  if (!exactOrigin(deployment.apiOrigin) || !exactOrigin(deployment.appOrigin)) {
    return "Sign-in is unavailable: it requires the app and the Claxedo server on exact HTTPS origins."
  }
  return null
}

/**
 * The same reason, for a startup that got as far as asking the deployment and
 * did not get a usable answer (the descriptor request failed, the live
 * descriptor does not match this build, the provider SDK would not load).
 * Same outcome as above and for the same reason: anonymous, with something to
 * say when the user tries to sign in.
 */
export function browserAuthUnavailableReason(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : String(error)
  return `Sign-in is unavailable: ${detail}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function exactOrigin(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function exactUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      `${url.origin}${url.pathname === "/" ? "" : url.pathname}` === value &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => !present(entry))) return undefined
  const entries = value.filter((entry): entry is string => present(entry))
  return new Set(entries).size === entries.length ? entries : undefined
}

function browserAuthMethods(value: unknown): BrowserAuthMethod[] | undefined {
  const entries = stringArray(value)
  if (!entries) return undefined
  const methods: BrowserAuthMethod[] = []
  for (const entry of entries) {
    switch (entry) {
      case "google":
      case "github":
      case "email-password":
        methods.push(entry)
        break
      default:
        return undefined
    }
  }
  return methods
}

function parseDescriptor(
  value: unknown,
  input: { selectedAdapter: BrowserAuthAdapterId; apiOrigin: string; appOrigin: string },
): BrowserAuthDescriptor {
  const descriptor = isRecord(value) ? value : undefined
  const browser = isRecord(descriptor?.browser) ? descriptor.browser : undefined
  const cookie = isRecord(browser?.cookie) ? browser.cookie : undefined
  const methods = browserAuthMethods(descriptor?.methods)
  const trustedOrigins = stringArray(browser?.trustedOrigins)
  const scopes = stringArray(browser?.scopes)
  const allowedMethods = new Set<unknown>(["google", "github", "email-password"])
  const expectedTransport = "cookie"
  const expectedPolicy = "reject-cookie-and-authorization"

  if (input.selectedAdapter !== "better-auth") {
    throw new BrowserAuthConfigurationError(
      `live auth descriptor does not match the ${input.selectedAdapter} browser build`,
    )
  }

  if (
    descriptor?.adapter !== input.selectedAdapter ||
    !present(descriptor.deploymentId) ||
    !present(descriptor.configurationVersion) ||
    typeof descriptor.expiresAt !== "number" ||
    !Number.isFinite(descriptor.expiresAt) ||
    descriptor.expiresAt <= Date.now() ||
    !present(descriptor.issuer) ||
    !exactUrl(descriptor.issuer) ||
    !methods?.length ||
    methods.some((method) => !allowedMethods.has(method)) ||
    browser?.transport !== expectedTransport ||
    browser.credentialPolicy !== expectedPolicy ||
    !trustedOrigins?.includes(input.appOrigin) ||
    trustedOrigins.some((origin) => !exactOrigin(origin)) ||
    !present(browser.clientId) ||
    !present(browser.resource) ||
    !exactUrl(browser.resource) ||
    new URL(browser.resource).origin !== input.apiOrigin ||
    !scopes?.length
  ) {
    throw new BrowserAuthConfigurationError(
      `live auth descriptor does not match the ${input.selectedAdapter} browser build`,
    )
  }

  if (
    descriptor.issuer !== `${input.apiOrigin}/api/auth` ||
    !cookie ||
    !present(cookie.name) ||
    cookie.path !== "/" ||
    cookie.secure !== true ||
    cookie.httpOnly !== true ||
    cookie.hostOnly !== true ||
    (cookie.sameSite !== "lax" && cookie.sameSite !== "strict")
  ) {
    throw new BrowserAuthConfigurationError("live Better Auth descriptor has an invalid cookie contract")
  }
  return {
    adapter: input.selectedAdapter,
    deploymentId: descriptor.deploymentId,
    configurationVersion: descriptor.configurationVersion,
    expiresAt: descriptor.expiresAt,
    issuer: descriptor.issuer,
    methods,
    browser: {
      trustedOrigins,
      clientId: browser.clientId,
      resource: browser.resource,
      scopes,
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      cookie: {
        name: cookie.name,
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: cookie.sameSite,
      },
    },
  }
}

export async function loadBrowserAuthDescriptor(input: {
  selectedAdapter: BrowserAuthAdapterId
  apiOrigin: string
  appOrigin: string
  request?: DescriptorRequest
}): Promise<BrowserAuthDescriptor> {
  if (!exactOrigin(input.apiOrigin) || !exactOrigin(input.appOrigin)) {
    throw new BrowserAuthConfigurationError("browser auth requires exact HTTPS API and app origins")
  }
  const request = input.request ?? fetch
  const response = await request(`${input.apiOrigin}/api/claxedo/auth/descriptor`, {
    credentials: "include",
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new BrowserAuthConfigurationError(`auth descriptor request failed with HTTP ${response.status}`)
  }
  return parseDescriptor(await response.json(), input)
}
