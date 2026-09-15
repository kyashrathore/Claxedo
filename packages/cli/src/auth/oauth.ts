import { object } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"
import type { FetchLike } from "./auth-descriptor"

/** RFC 6749 §5.2: the token endpoint reports `{ error, error_description }`, not the control plane's `{ error: { code } }`. */
export class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    description: string | undefined,
  ) {
    super(description ? `${error}: ${description}` : error)
  }
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}

function tokenSet(input: unknown): TokenSet {
  const row = object(input)
  const accessToken = trimToUndefined(row.access_token)
  if (!accessToken) throw new Error("Token response is missing access_token")
  const refreshToken = trimToUndefined(row.refresh_token)
  const tokenType = trimToUndefined(row.token_type)
  const expiresIn = asFiniteNumber(row.expires_in)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(expiresIn ? { expiresIn } : {}),
  }
}

/** One form-encoded POST to an OAuth token endpoint; the token set on 2xx, an `OAuthError` otherwise. */
export async function tokenRequest(input: { url: string; params: Record<string, string>; fetch?: FetchLike }): Promise<TokenSet> {
  const res = await (input.fetch ?? ((url, init) => fetch(url, init)))(new URL(input.url), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(input.params).toString(),
  })
  const body = (res.headers.get("content-type") ?? "").includes("application/json") ? await res.json().catch(() => undefined) : undefined
  if (res.ok) return tokenSet(body)
  const row = object(body)
  throw new OAuthError(res.status, trimToUndefined(row.error) ?? `http_${res.status}`, trimToUndefined(row.error_description))
}
