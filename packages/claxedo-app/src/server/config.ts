import type { RunHostedOperation } from "@claxedo/account-contract"
import { ServerError } from "./errors"
import type { RelayLinkStorage } from "./relay"

export type AccountEvents = (init: { readonly lastEventId?: string; readonly signal: AbortSignal }) => Promise<Response>

export type ServerConfig = {
  readonly serverUrl?: string
  readonly account?: RunHostedOperation
  readonly accountEvents?: AccountEvents
  readonly cookies?: boolean
  readonly onSignInRefused?: () => void
  readonly eventSocket?: boolean
  readonly relayLinks?: RelayLinkStorage
  /** Where this client reaches every relay room, when its origin fronts the relay; absent, each connection's own relay URL. */
  readonly relayUrl?: string
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

function pageOrigin(): string | undefined {
  return typeof window !== "undefined" && /^https?:$/.test(window.location.protocol) ? window.location.origin : undefined
}

export function resolveServerUrl(config: ServerConfig): string {
  const candidate = config.serverUrl ?? pageOrigin()
  if (!candidate) throw new ServerError({ class: "invalid", message: "No server URL: pass serverUrl when the daemon does not serve the page" })
  const url = candidate.trim().replace(/\/+$/, "")
  if (!URL.canParse(url)) throw new ServerError({ class: "invalid", message: `The server URL ${url} is not a URL` })
  return url
}

export function isLoopbackUrl(url: string) {
  const { hostname, protocol } = new URL(url)
  return (protocol === "http:" || protocol === "https:") && LOOPBACK_HOSTS.has(hostname)
}
