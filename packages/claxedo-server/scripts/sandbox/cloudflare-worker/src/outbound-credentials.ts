import { isWorkerRecord } from "./worker-json"

export type EgressRegistration = { name: string; hosts: string[]; header: string; value: string }

const PLACEHOLDER_PREFIX = "claxedo-broker:"

export function credentialPlaceholder(name: string) {
  return `${PLACEHOLDER_PREFIX}${name}`
}

/**
 * Whether the request is asking this handler for a credential at all.
 *
 * Interception is per-HOST, so everything the sandbox sends to a host that
 * happens to carry a registration arrives here — `git clone`, `npm install`,
 * `curl`, a request already carrying the user's own token. Only a request
 * presenting one of our placeholders is ours to answer.
 */
function presentsPlaceholder(request: Request) {
  for (const [, value] of request.headers) {
    if (value.includes(PLACEHOLDER_PREFIX)) return true
  }
  return false
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/** A non-empty list of plain hostnames, or nothing: one bad entry rejects the list. */
function registrationHosts(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const hosts: string[] = []
  for (const host of value) {
    if (typeof host !== "string" || !HOST_PATTERN.test(host)) return undefined
    hosts.push(host)
  }
  return hosts
}

export function parseRegistrations(input: unknown): EgressRegistration[] {
  if (!Array.isArray(input)) throw new Error("egress must be an array")
  const names = new Set<string>()
  return input.map((entry: unknown) => {
    if (!isWorkerRecord(entry)) throw new Error("invalid egress registration")
    const hosts = registrationHosts(entry.hosts)
    if (typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)
      || names.has(entry.name) || typeof entry.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.header)
      || typeof entry.value !== "string" || !entry.value || /[\r\n]/.test(entry.value)
      || !hosts) {
      throw new Error("invalid egress registration")
    }
    if (["host", "content-length", "connection", "transfer-encoding", "cookie", "proxy-authorization"].includes(entry.header.toLowerCase())) {
      throw new Error("invalid credential header")
    }
    names.add(entry.name)
    return { name: entry.name, header: entry.header, value: entry.value, hosts }
  })
}

export async function forwardCredential(request: Request, options: {
  registrations: () => Promise<EgressRegistration[]>
  fetch?: (request: Request) => Promise<Response>
}) {
  const send = options.fetch ?? fetch
  // Ordinary traffic to a registered host: forwarded exactly as sent, with no
  // credential attached and no response scrubbing, because nothing of ours is
  // in it. The protocol and destination rules below guard the ATTACHMENT of a
  // credential, so they apply only once one has been asked for.
  if (!presentsPlaceholder(request)) {
    try {
      return await send(request)
    } catch {
      return new Response("Upstream unavailable", { status: 502 })
    }
  }
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
    upstream = await send(new Request(request, { headers, redirect: "manual" }))
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
