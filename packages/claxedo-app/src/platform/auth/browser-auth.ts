import type { Accessor } from "solid-js"
import type { AuthDisplayUser } from "./auth-display"

export const BROWSER_AUTH_ADAPTERS = ["better-auth", "clerk"] as const
export const BROWSER_AUTH_METHODS = ["google", "github", "email-password", "clerk"] as const

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
  | { method: "google" | "github" | "clerk"; redirectUrl?: string }
  | { method: "email-password"; email: string; password: string; redirectUrl?: string }

export type BrowserAuthSignUpOptions =
  | { method?: undefined; redirectUrl?: string }
  | { method: "google" | "github" | "clerk"; redirectUrl?: string }
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

export type BrowserAuthAdapter = {
  readonly adapter: BrowserAuthAdapterId
  readonly transport: "cookie" | "bearer"
  readonly implementationMarker: string
  initialize(input: { apiOrigin: string; appOrigin: string }): Promise<void>
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
      case "clerk":
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
  const allowedMethods =
    input.selectedAdapter === "better-auth"
      ? new Set<unknown>(["google", "github", "email-password"])
      : new Set<unknown>(["clerk"])
  const expectedTransport = input.selectedAdapter === "better-auth" ? "cookie" : "bearer"
  const expectedPolicy =
    input.selectedAdapter === "better-auth" ? "reject-cookie-and-authorization" : "authorization-only"

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

  if (input.selectedAdapter === "better-auth") {
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

  if (cookie !== undefined) {
    throw new BrowserAuthConfigurationError("live Clerk descriptor must not select cookie transport")
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
      transport: "bearer",
      credentialPolicy: "authorization-only",
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
    credentials: input.selectedAdapter === "better-auth" ? "include" : "omit",
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new BrowserAuthConfigurationError(`auth descriptor request failed with HTTP ${response.status}`)
  }
  return parseDescriptor(await response.json(), input)
}
