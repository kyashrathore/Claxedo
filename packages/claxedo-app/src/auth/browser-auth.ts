import type { AuthAdapterDescriptor, BrowserAuthDescriptor as BrowserCredentialDescriptor, InteractiveAuthMethod } from "@claxedo/account-contract/auth"
import { isFiniteNumber, isRecord } from "@claxedo/helpers/guards"
import type { Accessor } from "solid-js"
import { exactHttps, readCookieContract, readLiveBrowserAuthDescriptor } from "./browser-auth-descriptor"
import type { AuthUser } from "./display-user"

export type BrowserAuthAdapterId = "better-auth"
export type BrowserAuthMethod = InteractiveAuthMethod
export type BrowserAuthDescriptor = Pick<AuthAdapterDescriptor, "deploymentId" | "configurationVersion" | "expiresAt" | "issuer" | "methods"> & {
  adapter: BrowserAuthAdapterId
  browser: Extract<BrowserCredentialDescriptor, { transport: "cookie" }>
}

export type BrowserAuthSignInOptions =
  | { method?: undefined; redirectUrl?: string }
  | { method: "google" | "github"; redirectUrl?: string }
  | { method: "email-password"; email: string; password: string; redirectUrl?: string }

export type BrowserAuthSignUpOptions = BrowserAuthSignInOptions & { name?: string }

export type BrowserAuthState = {
  descriptor: Accessor<BrowserAuthDescriptor | null>
  methods: Accessor<readonly BrowserAuthMethod[]>
  user: Accessor<AuthUser | null>
  loading: Accessor<boolean>
  unavailable: Accessor<string | null>
  signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  signOut: () => Promise<void>
  signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  refreshSession: () => Promise<void>
}

export type BrowserAuthDeployment = {
  /** The page's origin, which serves the auth and API routes too. */
  origin: string
  issuesSessions: boolean
}

export type BrowserAuthAdapter = {
  readonly adapter: BrowserAuthAdapterId
  initialize(input: BrowserAuthDeployment): Promise<void>
  useAuth(): BrowserAuthState
}

type DescriptorRequest = (input: string, init?: RequestInit) => Promise<Response>

export class BrowserAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserAuthConfigurationError"
  }
}

export function assertBrowserAuthDescriptorBinding(expected: BrowserAuthDescriptor, live: BrowserAuthDescriptor) {
  if (live.adapter !== expected.adapter || live.deploymentId !== expected.deploymentId || live.configurationVersion !== expected.configurationVersion) {
    throw new BrowserAuthConfigurationError("live browser auth configuration binding changed")
  }
}

export function browserAuthUnavailable(deployment: BrowserAuthDeployment): string | null {
  if (!deployment.issuesSessions) return "Sign-in is unavailable: this Claxedo server issues no sessions, so it has no accounts."
  if (!exactHttps(deployment.origin, true)) {
    return "Sign-in is unavailable: it requires the app on an exact HTTPS origin."
  }
  return null
}

export function browserAuthUnavailableReason(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : String(error)
  return `Sign-in is unavailable: ${detail}`
}

function parseDescriptor(value: unknown, input: { selectedAdapter: BrowserAuthAdapterId; origin: string }): BrowserAuthDescriptor {
  const descriptor = readLiveBrowserAuthDescriptor(value)
  if (!descriptor || !descriptor.browser.trustedOrigins.includes(input.origin) || new URL(descriptor.browser.resource).origin !== input.origin) {
    throw new BrowserAuthConfigurationError(`live auth descriptor does not match the ${input.selectedAdapter} browser build`)
  }
  const cookie = readCookieContract(descriptor.browser.cookie)
  if (descriptor.issuer !== `${input.origin}/api/auth` || !cookie) {
    throw new BrowserAuthConfigurationError("live Better Auth descriptor has an invalid cookie contract")
  }
  return { ...descriptor, browser: { ...descriptor.browser, cookie } }
}

function isDescriptorInDate(published: unknown): boolean {
  return isRecord(published) && isFiniteNumber(published.expiresAt) && published.expiresAt > Date.now()
}

export async function loadBrowserAuthDescriptor(input: {
  selectedAdapter: BrowserAuthAdapterId
  origin: string
  published?: unknown
  request?: DescriptorRequest
}): Promise<BrowserAuthDescriptor> {
  if (!exactHttps(input.origin, true)) {
    throw new BrowserAuthConfigurationError("browser auth requires an exact HTTPS origin")
  }
  if (isDescriptorInDate(input.published)) return parseDescriptor(input.published, input)
  const response = await (input.request ?? fetch)(`${input.origin}/api/claxedo/auth/descriptor`, {
    credentials: "include",
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new BrowserAuthConfigurationError(`auth descriptor request failed with HTTP ${response.status}`)
  return parseDescriptor(await response.json(), input)
}
