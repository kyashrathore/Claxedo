import { INTERACTIVE_AUTH_METHODS, type AuthAdapterDescriptor, type BrowserAuthDescriptor as BrowserCredentialDescriptor, type InteractiveAuthMethod } from "@claxedo/account-contract/auth"
import { z } from "zod"
import type { Accessor } from "solid-js"
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
  apiOrigin: string
  appOrigin: string
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

function exactHttps(value: string, origin = false) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const canonical = origin ? url.origin : `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
  return url.protocol === "https:" && canonical === value && !url.search && !url.hash && !url.username && !url.password
}

export function browserAuthUnavailable(deployment: BrowserAuthDeployment): string | null {
  if (!deployment.issuesSessions) return "Sign-in is unavailable: this Claxedo server issues no sessions, so it has no accounts."
  if (!exactHttps(deployment.apiOrigin, true) || !exactHttps(deployment.appOrigin, true)) {
    return "Sign-in is unavailable: it requires the app and the Claxedo server on exact HTTPS origins."
  }
  return null
}

export function browserAuthUnavailableReason(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : String(error)
  return `Sign-in is unavailable: ${detail}`
}

const text = z.string().refine((value) => value.trim().length > 0)
const uniqueTexts = z.array(text).refine((values) => new Set(values).size === values.length)
const httpsUrl = text.refine((value) => exactHttps(value))
const descriptorSchema = z.object({
  adapter: z.literal("better-auth"),
  deploymentId: text,
  configurationVersion: text,
  expiresAt: z.number().finite().refine((value) => value > Date.now()),
  issuer: httpsUrl,
  methods: z.array(z.enum(INTERACTIVE_AUTH_METHODS)).nonempty().refine((values) => new Set(values).size === values.length),
  browser: z.object({
    transport: z.literal("cookie"),
    credentialPolicy: z.literal("reject-cookie-and-authorization"),
    trustedOrigins: uniqueTexts.refine((values) => values.every((value) => exactHttps(value, true))),
    clientId: text,
    resource: httpsUrl,
    scopes: uniqueTexts.refine((values) => values.length > 0),
    cookie: z.unknown().optional(),
  }),
})
const cookieSchema = z.object({
  name: text,
  path: z.literal("/"),
  secure: z.literal(true),
  httpOnly: z.literal(true),
  hostOnly: z.literal(true),
  sameSite: z.enum(["lax", "strict"]),
})

function parseDescriptor(value: unknown, input: { selectedAdapter: BrowserAuthAdapterId; apiOrigin: string; appOrigin: string }): BrowserAuthDescriptor {
  const parsed = descriptorSchema.safeParse(value)
  if (!parsed.success || !parsed.data.browser.trustedOrigins.includes(input.appOrigin) || new URL(parsed.data.browser.resource).origin !== input.apiOrigin) {
    throw new BrowserAuthConfigurationError(`live auth descriptor does not match the ${input.selectedAdapter} browser build`)
  }
  const descriptor = parsed.data
  const cookie = cookieSchema.safeParse(descriptor.browser.cookie)
  if (descriptor.issuer !== `${input.apiOrigin}/api/auth` || !cookie.success) {
    throw new BrowserAuthConfigurationError("live Better Auth descriptor has an invalid cookie contract")
  }
  return { ...descriptor, browser: { ...descriptor.browser, cookie: cookie.data } }
}

export async function loadBrowserAuthDescriptor(input: {
  selectedAdapter: BrowserAuthAdapterId
  apiOrigin: string
  appOrigin: string
  request?: DescriptorRequest
}): Promise<BrowserAuthDescriptor> {
  if (!exactHttps(input.apiOrigin, true) || !exactHttps(input.appOrigin, true)) {
    throw new BrowserAuthConfigurationError("browser auth requires exact HTTPS API and app origins")
  }
  const response = await (input.request ?? fetch)(`${input.apiOrigin}/api/claxedo/auth/descriptor`, {
    credentials: "include",
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new BrowserAuthConfigurationError(`auth descriptor request failed with HTTP ${response.status}`)
  return parseDescriptor(await response.json(), input)
}
