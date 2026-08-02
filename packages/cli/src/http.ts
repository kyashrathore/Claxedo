import { object, text } from "./json"

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
    code: text(error.code),
    message: text(error.message) ?? fallback,
  }
}

export async function requestJson(input: { url: string; method?: string; token?: string; body?: unknown }) {
  const res = await fetch(input.url, {
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
