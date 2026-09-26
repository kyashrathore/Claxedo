import { createAuthClient } from "better-auth/client"
import type { AuthUser } from "./display-user"

type ClientError = { message?: string } | null
type ClientResult<T> = Promise<{ data: T | null; error: ClientError }>

export type BetterAuthSessionData = {
  session?: unknown
  user?: { id?: unknown; name?: unknown; email?: unknown; image?: unknown } | null
}

export type BetterAuthBrowserClient = {
  getSession(): ClientResult<BetterAuthSessionData>
  signIn: {
    social(input: { provider: "google" | "github"; callbackURL: string }): ClientResult<unknown>
    email(input: { email: string; password: string; callbackURL: string }): ClientResult<unknown>
  }
  signUp: {
    email(input: { email: string; password: string; name: string; callbackURL: string }): ClientResult<unknown>
  }
  signOut(): ClientResult<unknown>
}

export type BetterAuthClientFactory = (options: {
  baseURL: string
  fetchOptions: { credentials: "include" }
}) => BetterAuthBrowserClient

export const productionClientFactory: BetterAuthClientFactory = (options) => createAuthClient(options)

export async function clientResult<T>(action: string, call: ClientResult<T>): Promise<T | null> {
  const result = await call
  if (result.error) throw new Error(result.error.message || `Better Auth ${action} failed`)
  return result.data
}

export function callbackUrl(value: string | undefined, appOrigin: string) {
  const callback = new URL(value ?? "/", appOrigin)
  if (callback.origin !== appOrigin || callback.username || callback.password) {
    throw new Error("Better Auth requires an exact same-origin callback")
  }
  return callback.toString()
}

export function normalizedUser(value: BetterAuthSessionData["user"]): AuthUser | null {
  if (!value || typeof value.id !== "string" || !value.id) return null
  return {
    id: value.id,
    ...(typeof value.name === "string" && value.name ? { fullName: value.name } : {}),
    ...(typeof value.image === "string" && value.image ? { imageUrl: value.image } : {}),
    ...(typeof value.email === "string" && value.email ? { email: value.email } : {}),
  }
}
