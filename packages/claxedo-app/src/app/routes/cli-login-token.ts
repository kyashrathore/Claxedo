// Security-boundary helpers for the CLI sign-in handoff, extracted from
// `cli-login.tsx` so the localhost-only callback restriction, the token
// exchange, and the form construction can be tested directly.
import { getClaxedoServerUrl } from "@/platform/api/api"

/**
 * Return a normalized callback URL only when it is an `http:` loopback
 * address (127.0.0.1 / localhost / [::1]); otherwise `undefined`. This is the
 * gate that prevents the CLI token from being POSTed anywhere but the local
 * CLI listener.
 */
export function localCallback(input: string | null): string | undefined {
  if (!input) return
  try {
    const url = new URL(input)
    if (url.protocol !== "http:") return
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return
    return url.toString()
  } catch {
    return
  }
}

export function userIdentity(input: unknown): string {
  if (!input || typeof input !== "object") return "browser-session"
  const user = input as {
    id?: string
    fullName?: string | null
    primaryEmailAddress?: { emailAddress?: string | null } | null
  }
  return user.primaryEmailAddress?.emailAddress ?? user.fullName ?? user.id ?? "browser-session"
}

export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function number(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

export type CliTokenResult = {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}

/**
 * Exchange a browser session token for a CLI token via the Claxedo server.
 * Surfaces the server-provided error message on non-2xx responses, and
 * tolerates both snake_case and camelCase field spellings.
 */
export async function cliToken(browserToken: string): Promise<CliTokenResult> {
  const response = await fetch(`${getClaxedoServerUrl()}/api/auth/cli/exchange`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${browserToken}`,
    },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? (body.error as Record<string, unknown>) : undefined
    throw new Error(text(error?.message) ?? "CLI token exchange failed.")
  }
  if (!body || typeof body !== "object") throw new Error("CLI token exchange returned an invalid response.")
  const row = body as Record<string, unknown>
  const accessToken = text(row.access_token) ?? text(row.accessToken)
  if (!accessToken) throw new Error("CLI token exchange did not return an access token.")
  return {
    accessToken,
    refreshToken: text(row.refresh_token) ?? text(row.refreshToken),
    tokenType: text(row.token_type) ?? text(row.tokenType),
    expiresIn: number(row.expires_in) ?? number(row.expiresIn),
  }
}

/**
 * Build the hidden field set posted back to the CLI callback. Optional fields
 * are only included when present; `expires_in` is stringified. Split out from
 * DOM submission so the field shape is independently assertable.
 */
export function cliCallbackFields(input: {
  state: string
  accessToken: string
  identity: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}): Record<string, string> {
  return {
    state: input.state,
    access_token: input.accessToken,
    identity: input.identity,
    ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
    ...(input.tokenType ? { token_type: input.tokenType } : {}),
    ...(input.expiresIn ? { expires_in: String(input.expiresIn) } : {}),
  }
}

export function postToken(input: {
  callback: string
  state: string
  accessToken: string
  identity: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}) {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = input.callback
  form.style.display = "none"
  for (const [name, value] of Object.entries(cliCallbackFields(input))) {
    const field = document.createElement("input")
    field.type = "hidden"
    field.name = name
    field.value = value
    form.appendChild(field)
  }
  document.body.appendChild(form)
  form.submit()
}
