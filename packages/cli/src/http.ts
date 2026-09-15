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

export type RequestInput = {
  url: string
  method?: string
  token?: string
  body?: unknown
  /** Tests hand in a fake control plane; the global `fetch` otherwise. */
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
}

export async function requestJson(input: RequestInput) {
  const res = await (input.fetch ?? ((url, init) => fetch(url, init)))(new URL(input.url), {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  const contentType = res.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined
  if (res.ok) return body
  const detail = errorDetail(body, `${input.method ?? "GET"} ${input.url} failed with ${res.status}`)
  throw new ApiError(res.status, detail.code, detail.message)
}
