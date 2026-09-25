export type ContentSecurityPolicyInput = {
  readonly servers: readonly string[]
  readonly scripts?: readonly string[]
  readonly frames: "self" | "none"
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"])

export class ContentSecurityPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContentSecurityPolicyError"
  }
}

export function exactOrigin(value: string): string {
  if (value.includes("*")) throw new ContentSecurityPolicyError(`${value} is a wildcard; the policy names exact origins`)
  if (!URL.canParse(value)) throw new ContentSecurityPolicyError(`${value} is not a URL`)
  const url = new URL(value)
  if (!WEB_SCHEMES.has(url.protocol)) throw new ContentSecurityPolicyError(`${value} is not an http or https origin`)
  return url.origin
}

function socketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws")
}

function sources(...lists: readonly (readonly string[])[]): string {
  return lists.flat().join(" ")
}

export function contentSecurityPolicy(input: ContentSecurityPolicyInput): string {
  const servers = [...new Set(input.servers.map(exactOrigin))]
  const sockets = servers.map(socketOrigin)
  return [
    "default-src 'self'",
    `script-src ${sources(["'self'", "'wasm-unsafe-eval'", "blob:"], input.scripts ?? [])}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${sources(["'self'", "data:", "blob:"], servers)}`,
    "font-src 'self' data:",
    `media-src ${sources(["'self'", "data:", "blob:"], servers)}`,
    `connect-src ${sources(["'self'"], servers, sockets)}`,
    "worker-src 'self' blob:",
    `frame-src '${input.frames}'`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"]

export function browserPreviewPolicy(): string {
  const loopback = LOOPBACK_HOSTS.flatMap((host) => [`http://${host}:*`, `https://${host}:*`])
  return ["default-src 'none'", "style-src 'unsafe-inline'", `frame-src ${sources(loopback, ["https:"])}`, "base-uri 'none'", "form-action 'none'"].join("; ")
}

export function cliCallbackPolicy(): string {
  const loopback = LOOPBACK_HOSTS.map((host) => `http://${host}:*`)
  return ["default-src 'none'", "script-src 'self'", `form-action ${sources(loopback)}`, "base-uri 'none'"].join("; ")
}
