import { object } from "./json"
import { trimToUndefined } from "@claxedo/helpers/string"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

function errorDetail(input: unknown, fallback: string) {
  const body = object(input)
  const error = object(body.error)
  return {
    code: trimToUndefined(error.code),
    message: trimToUndefined(error.message) ?? fallback,
  }
}

/**
 * Every request this CLI makes carries authority — a bearer token, an
 * enrollment secret, or an OAuth grant — so a 3xx is an instruction to hand that
 * authority to whatever the `location` names, on whatever transport it names.
 * Validating the URL the caller asked for means nothing if the redirect is
 * followed, and `fetch` follows by default, so callers pass `redirect: "manual"`
 * and the answer is refused here instead.
 */
export function assertNotRedirected(res: Response, method: string, url: string) {
  if (res.status < 300 || res.status >= 400) return
  throw new ApiError(res.status, "redirected", `${method} ${url} was redirected to ${res.headers.get("location") ?? "an undisclosed location"}`)
}

export type RequestInput = {
  url: string
  method?: string
  token?: string
  body?: unknown
  /** Tests hand in a fake control plane; the global `fetch` otherwise. */
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
}

export async function requestJson(input: RequestInput) {
  const method = input.method ?? (input.body === undefined ? "GET" : "POST")
  const res = await (input.fetch ?? ((url, init) => fetch(url, init)))(new URL(input.url), {
    method,
    headers: {
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: "manual",
  })
  assertNotRedirected(res, method, input.url)
  const contentType = res.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined
  if (res.ok) return body
  const detail = errorDetail(body, `${method} ${input.url} failed with ${res.status}`)
  throw new ApiError(res.status, detail.code, detail.message)
}
