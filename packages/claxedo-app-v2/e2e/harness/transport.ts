import type { Page } from "@playwright/test"

export type HttpRequest = { method: string; url: string; headers?: Record<string, string>; body?: string }
export type HttpReply = { status: number; body: string }
export type HttpTransport = (request: HttpRequest) => Promise<HttpReply>

export const directTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body })
  return { status: response.status, body: await response.text() }
}

export function pageTransport(page: Page): HttpTransport {
  return (request) =>
    page.evaluate(async (input) => {
      const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body })
      return { status: response.status, body: await response.text() }
    }, request)
}

export async function sendJson(transport: HttpTransport, method: string, url: string, body: unknown, label: string) {
  const reply = await transport({ method, url, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (reply.status < 200 || reply.status >= 300) throw new Error(`${label} failed: ${reply.status} ${reply.body}`)
  return reply.body
}
