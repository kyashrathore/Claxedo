import {
  INTERACTIVE_AUTH_METHODS,
  type BrowserAuthDescriptor as BrowserCredentialDescriptor,
  type InteractiveAuthMethod,
} from "@claxedo/account-contract/auth"
import { isFiniteNumber, isNonBlankString, isRecord } from "@claxedo/helpers/guards"

export type CookieContract = Extract<BrowserCredentialDescriptor, { transport: "cookie" }>["cookie"]

export type LiveBrowserAuthDescriptor = {
  adapter: "better-auth"
  deploymentId: string
  configurationVersion: string
  expiresAt: number
  issuer: string
  methods: InteractiveAuthMethod[]
  browser: {
    transport: "cookie"
    credentialPolicy: "reject-cookie-and-authorization"
    trustedOrigins: string[]
    clientId: string
    resource: string
    scopes: string[]
    cookie?: unknown
  }
}

export function exactHttps(value: string, origin = false): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const canonical = origin ? url.origin : `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
  return url.protocol === "https:" && canonical === value && !url.search && !url.hash && !url.username && !url.password
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonBlankString) && unique(value)
}

function isMethod(value: unknown): value is InteractiveAuthMethod {
  return INTERACTIVE_AUTH_METHODS.some((method) => method === value)
}

function readBrowser(value: unknown): LiveBrowserAuthDescriptor["browser"] | undefined {
  if (!isRecord(value)) return undefined
  const { transport, credentialPolicy, trustedOrigins, clientId, resource, scopes } = value
  if (transport !== "cookie" || credentialPolicy !== "reject-cookie-and-authorization") return undefined
  if (!textList(trustedOrigins) || !trustedOrigins.every((origin) => exactHttps(origin, true))) return undefined
  if (!isNonBlankString(clientId) || !isNonBlankString(resource) || !exactHttps(resource)) return undefined
  if (!textList(scopes) || scopes.length === 0) return undefined
  const browser: LiveBrowserAuthDescriptor["browser"] = {
    transport,
    credentialPolicy,
    trustedOrigins,
    clientId,
    resource,
    scopes,
  }
  if ("cookie" in value) browser.cookie = value.cookie
  return browser
}

export function readLiveBrowserAuthDescriptor(value: unknown): LiveBrowserAuthDescriptor | undefined {
  if (!isRecord(value)) return undefined
  const { adapter, deploymentId, configurationVersion, expiresAt, issuer, methods } = value
  if (adapter !== "better-auth" || !isNonBlankString(deploymentId) || !isNonBlankString(configurationVersion))
    return undefined
  if (!isFiniteNumber(expiresAt) || expiresAt <= Date.now()) return undefined
  if (!isNonBlankString(issuer) || !exactHttps(issuer)) return undefined
  if (!Array.isArray(methods) || methods.length === 0 || !methods.every(isMethod) || !unique(methods)) return undefined
  const browser = readBrowser(value.browser)
  if (!browser) return undefined
  return { adapter, deploymentId, configurationVersion, expiresAt, issuer, methods, browser }
}

export function readCookieContract(value: unknown): CookieContract | undefined {
  if (!isRecord(value)) return undefined
  const { name, path, secure, httpOnly, hostOnly, sameSite } = value
  if (!isNonBlankString(name) || path !== "/" || secure !== true || httpOnly !== true || hostOnly !== true)
    return undefined
  if (sameSite !== "lax" && sameSite !== "strict") return undefined
  return { name, path, secure, httpOnly, hostOnly, sameSite }
}
