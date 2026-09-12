export type EgressRegistration = { name: string; hosts: string[]; header: string; value: string }

export function credentialPlaceholder(name: string) {
  return `claxedo-broker:${name}`
}

export function parseRegistrations(input: unknown): EgressRegistration[] {
  if (!Array.isArray(input)) throw new Error("egress must be an array")
  const names = new Set<string>()
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid egress registration")
    const name = "name" in entry ? entry.name : undefined
    const header = "header" in entry ? entry.header : undefined
    const value = "value" in entry ? entry.value : undefined
    const hosts = "hosts" in entry ? entry.hosts : undefined
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || names.has(name) || typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)
      || typeof value !== "string" || !value || /[\r\n]/.test(value)
      || !Array.isArray(hosts) || !hosts.length
      || !hosts.every((host: unknown): host is string => typeof host === "string" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host))) {
      throw new Error("invalid egress registration")
    }
    if (["host", "content-length", "connection", "transfer-encoding", "cookie", "proxy-authorization"].includes(header.toLowerCase())) {
      throw new Error("invalid credential header")
    }
    names.add(name)
    return { name, header, value, hosts }
  })
}

export async function forwardCredential(request: Request, options: {
  registrations: () => Promise<EgressRegistration[]>
  fetch?: (request: Request) => Promise<Response>
}) {
  const url = new URL(request.url)
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    return new Response("Forbidden", { status: 403 })
  }
  let registrations: EgressRegistration[]
  try {
    registrations = await options.registrations()
  } catch {
    return new Response("Credential authority unavailable", { status: 503 })
  }
  const matches = registrations.filter((row) => {
    if (!row.hosts.includes(url.hostname)) return false
    const incoming = request.headers.get(row.header)
    const placeholder = credentialPlaceholder(row.name)
    return incoming === placeholder || (row.header.toLowerCase() === "authorization" && incoming === `Bearer ${placeholder}`)
  })
  if (matches.length !== 1) return new Response("Forbidden", { status: 403 })
  const selected = matches[0]
  const headers = new Headers(request.headers)
  for (const name of ["authorization", "x-api-key", "cookie", "proxy-authorization", "host", "connection", "transfer-encoding", ...registrations.map((row) => row.header)]) headers.delete(name)
  headers.set(selected.header, selected.value)
  let upstream: Response
  try {
    upstream = await (options.fetch ?? fetch)(new Request(request, { headers, redirect: "manual" }))
  } catch {
    return new Response("Upstream unavailable", { status: 502 })
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel()
    return new Response("Upstream redirect rejected", { status: 502 })
  }
  const responseHeaders = new Headers(upstream.headers)
  for (const name of ["authorization", "x-api-key", "set-cookie", ...registrations.map((row) => row.header)]) responseHeaders.delete(name)
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
}
