import { readField } from "@/lib/record"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AuthUser } from "./display-user"
import { authResponseBody } from "./better-auth-error"
import { apiOrigin } from "./origins"

export function userIdentity(user: AuthUser | null): string {
  return user?.email ?? user?.fullName ?? user?.id ?? "browser-session"
}

export type CliTokenResult = {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
}

export async function cliToken(browserToken: string): Promise<CliTokenResult> {
  const response = await fetch(`${apiOrigin()}/api/auth/cli/exchange`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${browserToken}`,
    },
  })
  const body = await authResponseBody(response)
  if (!response.ok) {
    throw new Error(trimToUndefined(readField(readField(body, "error"), "message")) ?? "CLI token exchange failed.")
  }
  const row = asRecord(body)
  if (!row) throw new Error("CLI token exchange returned an invalid response.")
  const accessToken = trimToUndefined(row.access_token) ?? trimToUndefined(row.accessToken)
  if (!accessToken) throw new Error("CLI token exchange did not return an access token.")
  return {
    accessToken,
    refreshToken: trimToUndefined(row.refresh_token) ?? trimToUndefined(row.refreshToken),
    tokenType: trimToUndefined(row.token_type) ?? trimToUndefined(row.tokenType),
    expiresIn: asFiniteNumber(row.expires_in) ?? asFiniteNumber(row.expiresIn),
  }
}

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
