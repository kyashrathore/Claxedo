import { isNonBlankString } from "@claxedo/helpers/guards"
import type { Accessor } from "solid-js"
import type { AuthUser } from "./display-user"
import { asRecord } from "@/lib/record"

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
  user: Accessor<AuthUser | null>
  loading: Accessor<boolean>
  unavailable: Accessor<string | null>
  signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  signOut: () => Promise<void>
  signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>
  refreshSession: () => Promise<void>
}

export type BrowserAuthDeployment = {
  apiOrigin: string
  appOrigin: string
  issuesSessions: boolean
}

export type BrowserAuthAdapter = {
  readonly adapter: BrowserAuthAdapterId
  readonly transport: "cookie" | "bearer"
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

export function browserAuthUnavailable(deployment: BrowserAuthDeployment): string | null {
  if (!deployment.issuesSessions) {
    return "Sign-in is unavailable: this Claxedo server issues no sessions, so it has no accounts."
  }
  if (!exactOrigin(deployment.apiOrigin) || !exactOrigin(deployment.appOrigin)) {
    return "Sign-in is unavailable: it requires the app and the Claxedo server on exact HTTPS origins."
  }
  return null
}

export function browserAuthUnavailableReason(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : String(error)
  return `Sign-in is unavailable: ${detail}`
}

function exactOrigin(value: string) {
  if (!URL.canParse(value)) return false
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
}

function exactUrl(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === "https:" &&
    `${url.origin}${url.pathname === "/" ? "" : url.pathname}` === value &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  )
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => !isNonBlankString(entry))) return undefined
  const entries = value.filter((entry): entry is string => isNonBlankString(entry))
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

function descriptorMatches(
  descriptor: Record<string, unknown>,
  browser: Record<string, unknown>,
  input: { selectedAdapter: BrowserAuthAdapterId; apiOrigin: string; appOrigin: string },
) {
  const methods = browserAuthMethods(descriptor.methods)
  const trustedOrigins = stringArray(browser.trustedOrigins)
  const scopes = stringArray(browser.scopes)
  return (
    descriptor.adapter === input.selectedAdapter &&
    isNonBlankString(descriptor.deploymentId) &&
    isNonBlankString(descriptor.configurationVersion) &&
    typeof descriptor.expiresAt === "number" &&
    Number.isFinite(descriptor.expiresAt) &&
    descriptor.expiresAt > Date.now() &&
    isNonBlankString(descriptor.issuer) &&
    exactUrl(descriptor.issuer) &&
    !!methods?.length &&
    browser.transport === "cookie" &&
    browser.credentialPolicy === "reject-cookie-and-authorization" &&
    !!trustedOrigins?.includes(input.appOrigin) &&
    trustedOrigins.every(exactOrigin) &&
    isNonBlankString(browser.clientId) &&
    isNonBlankString(browser.resource) &&
    exactUrl(browser.resource) &&
    new URL(browser.resource).origin === input.apiOrigin &&
    !!scopes?.length
  )
}

function cookieMatches(issuer: string, apiOrigin: string, cookie: Record<string, unknown> | undefined) {
  return (
    issuer === `${apiOrigin}/api/auth` &&
    !!cookie &&
    isNonBlankString(cookie.name) &&
    cookie.path === "/" &&
    cookie.secure === true &&
    cookie.httpOnly === true &&
    cookie.hostOnly === true &&
    (cookie.sameSite === "lax" || cookie.sameSite === "strict")
  )
}

function parseDescriptor(
  value: unknown,
  input: { selectedAdapter: BrowserAuthAdapterId; apiOrigin: string; appOrigin: string },
): BrowserAuthDescriptor {
  const descriptor = asRecord(value) ?? {}
  const browser = asRecord(descriptor.browser) ?? {}
  const cookie = asRecord(browser.cookie)
  if (!descriptorMatches(descriptor, browser, input)) {
    throw new BrowserAuthConfigurationError(
      `live auth descriptor does not match the ${input.selectedAdapter} browser build`,
    )
  }
  if (!cookieMatches(descriptor.issuer as string, input.apiOrigin, cookie)) {
    throw new BrowserAuthConfigurationError("live Better Auth descriptor has an invalid cookie contract")
  }
  return {
    adapter: input.selectedAdapter,
    deploymentId: descriptor.deploymentId as string,
    configurationVersion: descriptor.configurationVersion as string,
    expiresAt: descriptor.expiresAt as number,
    issuer: descriptor.issuer as string,
    methods: browserAuthMethods(descriptor.methods) ?? [],
    browser: {
      trustedOrigins: stringArray(browser.trustedOrigins) ?? [],
      clientId: browser.clientId as string,
      resource: browser.resource as string,
      scopes: stringArray(browser.scopes) ?? [],
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      cookie: {
        name: cookie!.name as string,
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: cookie!.sameSite as "lax" | "strict",
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
