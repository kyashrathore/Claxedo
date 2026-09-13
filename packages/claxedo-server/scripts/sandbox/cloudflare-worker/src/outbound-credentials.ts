import { isWorkerRecord } from "./worker-json"

export type EgressRegistration = {
  name: string
  hosts: string[]
  header: string
  value: string
  /**
   * The request line the credential may be attached to, on top of `hosts`.
   * A vendor host serves far more than the routes a turn needs, and everything
   * sharing the sandbox reaches the same host.
   *
   * Empty means the producer named a host and nothing else, and nothing is
   * spendable at a host alone: the placeholder is then refused everywhere, so a
   * producer that predates the policy fails closed rather than forwarding the
   * operator's key to whatever route a request happened to name.
   */
  methods: string[]
  pathPrefixes: string[]
}

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
const METHOD_PATTERN = /^[A-Z]+$/

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

/**
 * A list of strings every entry of which passes `valid`, or nothing: one bad
 * entry rejects the list, the same rule `registrationHosts` follows. An absent
 * field is an empty list rather than a rejection, so a producer that predates
 * the policy still provisions its sandbox and is refused only at the request.
 */
function registrationStrings(value: unknown, valid: (entry: string) => boolean): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !valid(entry)) return undefined
    entries.push(entry)
  }
  return entries
}

export function parseRegistrations(input: unknown): EgressRegistration[] {
  if (!Array.isArray(input)) throw new Error("egress must be an array")
  const names = new Set<string>()
  return input.map((entry: unknown) => {
    if (!isWorkerRecord(entry)) throw new Error("invalid egress registration")
    const hosts = registrationHosts(entry.hosts)
    const methods = registrationStrings(entry.methods, (method) => METHOD_PATTERN.test(method))
    const pathPrefixes = registrationStrings(entry.pathPrefixes, (prefix) => prefix.startsWith("/"))
    if (typeof entry.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)
      || names.has(entry.name) || typeof entry.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.header)
      || typeof entry.value !== "string" || !entry.value || /[\r\n]/.test(entry.value)
      || !hosts || !methods || !pathPrefixes) {
      throw new Error("invalid egress registration")
    }
    if (["host", "content-length", "connection", "transfer-encoding", "cookie", "proxy-authorization"].includes(entry.header.toLowerCase())) {
      throw new Error("invalid credential header")
    }
    names.add(entry.name)
    return { name: entry.name, header: entry.header, value: entry.value, hosts, methods, pathPrefixes }
  })
}

/**
 * Whether the credential may ride on this request line.
 *
 * Encoded separators and dot segments are refused outright: an upstream router
 * can decode `%2f` and `%2e%2e` differently from `URL`, so a path that passes
 * the prefix test here can name another route there.
 */
function withinPolicy(row: EgressRegistration, method: string, pathname: string) {
  if (/%(?:2f|5c|2e|25)/i.test(pathname) || pathname.includes("\\")) return false
  if (!row.methods.includes(method)) return false
  return row.pathPrefixes.some((prefix) => pathname === prefix
    || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
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
  if (!withinPolicy(selected, request.method, url.pathname)) return new Response("Forbidden", { status: 403 })
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
