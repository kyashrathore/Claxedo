export type HttpRequest = { method: string; url: string; headers?: Record<string, string>; body?: string }
export type HttpReply = { status: number; body: string }
export type HttpTransport = (request: HttpRequest) => Promise<HttpReply>

export const directTransport: HttpTransport = async (request) => {
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body })
    return { status: response.status, body: await response.text() }
  } catch (cause) {
    throw new Error(`Waiting for ${request.method} ${new URL(request.url).pathname} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export async function sendJson(transport: HttpTransport, method: string, url: string, body: unknown, label: string) {
  const reply = await transport({ method, url, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (reply.status < 200 || reply.status >= 300) throw new Error(`${label} failed: ${reply.status} ${reply.body}`)
  return reply.body
}

export function bearerTransport(token: string): HttpTransport {
  return (request) => directTransport({ ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } })
}
