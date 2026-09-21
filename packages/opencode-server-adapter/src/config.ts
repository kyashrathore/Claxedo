import type { HarnessConnectionCapabilities } from "@claxedo/agent-sdk-runtime"
import { isRecord } from "@claxedo/helpers/guards"
import { OpenCodeServerAdapterError } from "./errors"

export type OpenCodeServerAuthRef =
  | { type: "basic"; username?: string; passwordSecret: string }
  | { type: "header"; name: string; valueSecret: string }

export type OpenCodeServerWorkspacePath = { sourceDirectory: string; targetDirectory: string }

export type OpenCodeServerConnectionConfig = {
  label: string
  baseUrl: string
  workspacePaths: OpenCodeServerWorkspacePath[]
  auth?: OpenCodeServerAuthRef
  trustedHeaders?: Record<string, string>
  tenant?: { header: string; value: string }
  reconnect: { maxAttempts: number; delayMs: number }
  deadlines: { requestMs: number; streamIdleMs: number }
}

export type ResolvedOpenCodeServerConnection = Omit<OpenCodeServerConnectionConfig, "auth" | "trustedHeaders"> & {
  connectionId: string
  sourceDirectory: string
  targetDirectory: string
  auth?: { type: "basic"; username: string; password: string } | { type: "header"; name: string; value: string }
  trustedHeaders: Record<string, string>
  redactions: string[]
}

export const OPENCODE_SERVER_CONNECTION_CAPABILITIES: HarnessConnectionCapabilities = {
  abort: true,
  reconnect: true,
  replay: false,
  permissions: false,
  questions: false,
  todos: true,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
  subagents: false,
}

export function validateOpenCodeServerConnectionConfig(input: unknown): OpenCodeServerConnectionConfig {
  const config = object(input, "config")
  const label = text(config.label, "label")
  const url = parseServerUrl(text(config.baseUrl, "baseUrl"))
  const workspacePaths = parseWorkspacePaths(config.workspacePaths)
  const auth = config.auth === undefined ? undefined : parseAuth(config.auth)
  const trustedHeaders = config.trustedHeaders === undefined ? undefined : parseSecretHeaders(config.trustedHeaders)
  const tenant = config.tenant === undefined ? undefined : parseTenant(config.tenant)
  const reconnect = config.reconnect === undefined ? { maxAttempts: 2, delayMs: 100 } : parseReconnect(config.reconnect)
  const deadlines = config.deadlines === undefined
    ? { requestMs: 15_000, streamIdleMs: 30_000 }
    : parseDeadlines(config.deadlines)
  const reserved = new Set(["x-opencode-directory", "content-length", "host"])
  for (const name of Object.keys(trustedHeaders ?? {})) {
    if (reserved.has(name.toLowerCase())) throw invalid(`trustedHeaders cannot set reserved header ${name}`)
  }
  if (tenant && reserved.has(tenant.header.toLowerCase())) throw invalid(`tenant cannot set reserved header ${tenant.header}`)
  return {
    label,
    baseUrl: url.toString().replace(/\/$/, ""),
    workspacePaths,
    ...(auth ? { auth } : {}),
    ...(trustedHeaders ? { trustedHeaders } : {}),
    ...(tenant ? { tenant } : {}),
    reconnect,
    deadlines,
  }
}

export function connectionIdentityFingerprint(config: OpenCodeServerConnectionConfig) {
  return JSON.stringify({
    baseUrl: config.baseUrl,
    workspacePaths: [...config.workspacePaths].sort((a, b) => a.sourceDirectory.localeCompare(b.sourceDirectory)),
    tenant: config.tenant ?? null,
    auth: config.auth?.type === "basic"
      ? { type: "basic", username: config.auth.username ?? "opencode" }
      : config.auth
        ? { type: "header", name: config.auth.name.toLowerCase() }
        : null,
    trustedHeaderNames: Object.keys(config.trustedHeaders ?? {}).map((name) => name.toLowerCase()).sort(),
  })
}

export function configuredSecretNames(config: OpenCodeServerConnectionConfig) {
  const names = new Set<string>()
  if (config.auth?.type === "basic") names.add(config.auth.passwordSecret)
  if (config.auth?.type === "header") names.add(config.auth.valueSecret)
  for (const name of Object.values(config.trustedHeaders ?? {})) names.add(name)
  return [...names].sort()
}

export function resolveOpenCodeServerConnection(input: {
  connectionId: string
  config: OpenCodeServerConnectionConfig
  sourceDirectory: string
  secrets: Readonly<Record<string, string>>
}): ResolvedOpenCodeServerConnection {
  const mapping = input.config.workspacePaths.find((item) => item.sourceDirectory === input.sourceDirectory)
  if (!mapping) throw new OpenCodeServerAdapterError("invalid_directory", "Workspace directory has no configured OpenCode path mapping")
  const required = new Set(configuredSecretNames(input.config))
  const received = Object.keys(input.secrets)
  if (received.length !== required.size || received.some((name) => !required.has(name))) {
    throw invalid("Resolved secret names do not match configured secret references")
  }
  for (const name of required) {
    if (typeof input.secrets[name] !== "string" || input.secrets[name].length === 0) throw invalid(`Resolved secret ${name} is missing`)
  }
  const auth = input.config.auth?.type === "basic"
    ? { type: "basic" as const, username: input.config.auth.username ?? "opencode", password: input.secrets[input.config.auth.passwordSecret]! }
    : input.config.auth
      ? { type: "header" as const, name: input.config.auth.name, value: resolvedHeaderValue(input.secrets[input.config.auth.valueSecret]!, "auth.valueSecret") }
      : undefined
  const trustedHeaders: Record<string, string> = {}
  for (const [name, secret] of Object.entries(input.config.trustedHeaders ?? {})) {
    trustedHeaders[name] = resolvedHeaderValue(input.secrets[secret]!, `trustedHeaders.${name}`)
  }
  const { auth: _auth, trustedHeaders: _trustedHeaders, ...publicConfig } = input.config
  const basicAuthorization = auth?.type === "basic"
    ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`
    : undefined
  return {
    ...publicConfig,
    connectionId: input.connectionId,
    sourceDirectory: mapping.sourceDirectory,
    targetDirectory: mapping.targetDirectory,
    ...(auth ? { auth } : {}),
    trustedHeaders,
    redactions: [...new Set([
      ...Object.values(input.secrets).flatMap((secret) => [secret, encodeURIComponent(secret)]),
      ...(basicAuthorization
        ? [basicAuthorization, basicAuthorization.slice("Basic ".length), encodeURIComponent(basicAuthorization)]
        : []),
    ])],
  }
}

function parseServerUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw invalid("baseUrl must be a valid URL") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("baseUrl must use http or https")
  if (url.username || url.password) throw invalid("baseUrl must not contain credentials")
  if (url.search || url.hash) throw invalid("baseUrl must not contain a query or fragment")
  return url
}

function parseWorkspacePaths(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) throw invalid("workspacePaths must be a non-empty array")
  const seen = new Set<string>()
  return input.map((value, index) => {
    const row = object(value, `workspacePaths.${index}`)
    const sourceDirectory = absolutePath(row.sourceDirectory, `workspacePaths.${index}.sourceDirectory`)
    const targetDirectory = absolutePath(row.targetDirectory, `workspacePaths.${index}.targetDirectory`)
    if (seen.has(sourceDirectory)) throw invalid(`workspacePaths repeats sourceDirectory ${sourceDirectory}`)
    seen.add(sourceDirectory)
    return { sourceDirectory, targetDirectory }
  })
}

function absolutePath(input: unknown, field: string) {
  const value = text(input, field)
  if (!value.startsWith("/")) throw invalid(`${field} must be an absolute POSIX path`)
  if (value.includes("\0") || value.includes("\\")) throw invalid(`${field} is invalid`)
  const parts = value.split("/")
  if (parts.some((part) => part === "." || part === "..") || value.includes("//") || (value.length > 1 && value.endsWith("/"))) {
    throw invalid(`${field} must be normalized`)
  }
  return value
}

function parseAuth(input: unknown): OpenCodeServerAuthRef {
  const auth = object(input, "auth")
  if (auth.type === "basic") {
    return { type: "basic", ...(auth.username === undefined ? {} : { username: text(auth.username, "auth.username") }), passwordSecret: opaque(auth.passwordSecret, "auth.passwordSecret") }
  }
  if (auth.type === "header") return { type: "header", name: headerName(auth.name, "auth.name"), valueSecret: opaque(auth.valueSecret, "auth.valueSecret") }
  throw invalid("auth.type must be basic or header")
}

function parseSecretHeaders(input: unknown) {
  const source = object(input, "trustedHeaders")
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) headers[headerName(name, `trustedHeaders.${name}`)] = opaque(value, `trustedHeaders.${name}`)
  return headers
}

function parseTenant(input: unknown) {
  const tenant = object(input, "tenant")
  return { header: headerName(tenant.header, "tenant.header"), value: headerValue(tenant.value, "tenant.value") }
}

function parseReconnect(input: unknown) {
  const value = object(input, "reconnect")
  return {
    maxAttempts: integer(value.maxAttempts, "reconnect.maxAttempts", 0, 10),
    delayMs: integer(value.delayMs, "reconnect.delayMs", 0, 30_000),
  }
}

function parseDeadlines(input: unknown) {
  const value = object(input, "deadlines")
  return {
    requestMs: integer(value.requestMs, "deadlines.requestMs", 1, 120_000),
    streamIdleMs: integer(value.streamIdleMs, "deadlines.streamIdleMs", 1, 300_000),
  }
}

function object(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input)) throw invalid(`${field} must be an object`)
  return input
}

function text(input: unknown, field: string) {
  if (typeof input !== "string" || input.trim().length === 0) throw invalid(`${field} must be a non-empty string`)
  return input.trim()
}

function opaque(input: unknown, field: string) {
  const value = text(input, field)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw invalid(`${field} must be an opaque secret name`)
  return value
}

function headerName(input: unknown, field: string) {
  const value = text(input, field)
  try { new Headers({ [value]: "valid" }) } catch { throw invalid(`${field} must be a valid header name`) }
  return value
}

function headerValue(input: unknown, field: string) {
  const value = text(input, field)
  try { new Headers({ "x-claxedo-check": value }) } catch { throw invalid(`${field} must be a valid header value`) }
  return value
}

// Resolved secret material is validated without trimming so the header sent
// matches the vault value byte for byte; the value itself never enters errors.
function resolvedHeaderValue(value: string, field: string) {
  try { new Headers({ "x-claxedo-check": value }) } catch { throw invalid(`${field} resolved to an invalid header value`) }
  return value
}

function integer(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) {
    throw invalid(`${field} must be an integer from ${min} to ${max}`)
  }
  return input
}

function invalid(message: string) { return new OpenCodeServerAdapterError("invalid_config", message) }
