/// <reference types="vite/client" />
import type { RunHostedOperation } from "@claxedo/account-contract"
import { ServerError } from "./errors"

export type AuthSource =
  | { readonly kind: "none" }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: (options?: { readonly fresh?: boolean }) => Promise<string | undefined> }

export type ServerConfig = {
  readonly serverUrl?: string
  readonly auth: AuthSource
  readonly account?: RunHostedOperation
  readonly thisMachineReport?: () => Promise<unknown>
  readonly cookies?: boolean
  readonly eventSocket?: boolean
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

function configuredServerUrl(): string | undefined {
  const configured = import.meta.env.VITE_CLAXEDO_SERVER_URL
  return typeof configured === "string" && configured.trim() ? configured : undefined
}

function pageOrigin(): string | undefined {
  return typeof window !== "undefined" && /^https?:$/.test(window.location.protocol) ? window.location.origin : undefined
}

export function resolveServerUrl(config: ServerConfig): string {
  const candidate = config.serverUrl ?? configuredServerUrl() ?? pageOrigin()
  if (!candidate) throw new ServerError({ class: "invalid", message: "No server URL: pass serverUrl when the daemon does not serve the page" })
  const url = candidate.trim().replace(/\/+$/, "")
  if (!URL.canParse(url)) throw new ServerError({ class: "invalid", message: `The server URL ${url} is not a URL` })
  return url
}

export function isLoopbackUrl(url: string) {
  const { hostname, protocol } = new URL(url)
  return (protocol === "http:" || protocol === "https:") && LOOPBACK_HOSTS.has(hostname)
}
