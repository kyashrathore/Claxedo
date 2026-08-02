// Vendored from arctic@2.3.4 (MIT) — see LICENSE-NOTICE.md.
// Adaptations: node Buffer base64; injectable fetch for tests.
import { OAuth2Tokens } from "./oauth2.js"

export type FetchLike = (request: Request) => Promise<Response>

export function createOAuth2Request(endpoint: string, body: URLSearchParams): Request {
  const bodyBytes = new TextEncoder().encode(body.toString())
  const request = new Request(endpoint, {
    method: "POST",
    body: bodyBytes,
  })
  request.headers.set("Content-Type", "application/x-www-form-urlencoded")
  request.headers.set("Accept", "application/json")
  // Required by GitHub, and probably by others as well
  request.headers.set("User-Agent", "claxedo-connections")
  return request
}

export function encodeBasicCredentials(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString("base64")
}

export async function sendTokenRequest(request: Request, fetchImpl: FetchLike = fetch): Promise<OAuth2Tokens> {
  let response: Response
  try {
    response = await fetchImpl(request)
  } catch (e) {
    throw new ArcticFetchError(e)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error("Failed to parse response body")
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("Unexpected response body data")
  }
  if ("error" in data && typeof (data as { error: unknown }).error === "string") {
    throw createOAuth2RequestError(data as Record<string, unknown>)
  }
  return new OAuth2Tokens(data as Record<string, unknown>)
}

export async function sendTokenRevocationRequest(request: Request, fetchImpl: FetchLike = fetch): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(request)
  } catch (e) {
    throw new ArcticFetchError(e)
  }
  if (response.ok) {
    if (response.body !== null) await response.body.cancel()
    return
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error("Failed to parse response body")
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("Unexpected response body data")
  }
  if ("error" in data && typeof (data as { error: unknown }).error === "string") {
    throw createOAuth2RequestError(data as Record<string, unknown>)
  }
}

function createOAuth2RequestError(result: Record<string, unknown>): OAuth2RequestError {
  if (typeof result.error !== "string") throw new Error("Invalid error response")
  const description = typeof result.error_description === "string" ? result.error_description : null
  const uri = typeof result.error_uri === "string" ? result.error_uri : null
  const state = typeof result.state === "string" ? result.state : null
  return new OAuth2RequestError(result.error, description, uri, state)
}

export class ArcticFetchError extends Error {
  constructor(cause: unknown) {
    super("Failed to send request", { cause })
  }
}

export class OAuth2RequestError extends Error {
  code: string
  description: string | null
  uri: string | null
  state: string | null

  constructor(code: string, description: string | null, uri: string | null, state: string | null) {
    super(`OAuth request error: ${code}`)
    this.code = code
    this.description = description
    this.uri = uri
    this.state = state
  }
}
