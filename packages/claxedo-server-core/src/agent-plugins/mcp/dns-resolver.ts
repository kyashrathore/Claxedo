import { isRecord } from "@claxedo/helpers/guards"
import type { McpOAuthAddressResolver } from "./discovery"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * DNS-over-HTTPS against Cloudflare's resolver, reached by IP literal so the
 * resolver itself needs no DNS. workerd has no `node:dns`, and the discovery
 * destination policy cannot check a name it cannot see through — this is the
 * resolver port it wires in production.
 *
 * Answers are cached briefly so a discovery that walks several well-known
 * candidates on one origin pays the lookup once.
 */
const DOH_ENDPOINT = "https://1.1.1.1/dns-query"
const CACHE_TTL_MS = 60_000

async function dohQuery(fetcher: Fetch, name: string, type: "A" | "AAAA", depth: number): Promise<string[]> {
  const response = await fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  })
  if (!response.ok) return []
  const raw: unknown = await response.json()
  if (!isRecord(raw) || raw.Status !== 0 || !Array.isArray(raw.Answer)) return []
  const wanted = type === "A" ? 1 : 28
  const answers = raw.Answer.filter(isRecord)
  const addresses = answers.flatMap((answer) =>
    answer.type === wanted && typeof answer.data === "string" ? [answer.data] : [])
  if (addresses.length) return addresses
  // A CNAME-only answer names the target worth asking again for.
  const alias = answers.find((answer) => answer.type === 5 && typeof answer.data === "string")?.data
  if (typeof alias === "string" && depth > 0) return dohQuery(fetcher, alias, type, depth - 1)
  return []
}

export function dohAddressResolver(fetcher: Fetch): McpOAuthAddressResolver {
  const cache = new Map<string, { expires: number; addresses: readonly string[] }>()
  return async (hostname) => {
    const hit = cache.get(hostname)
    if (hit && hit.expires > Date.now()) return hit.addresses
    const [v4, v6] = await Promise.all([
      dohQuery(fetcher, hostname, "A", 3).catch(() => [] as string[]),
      dohQuery(fetcher, hostname, "AAAA", 3).catch(() => [] as string[]),
    ])
    // An empty answer is a resolution FAILURE for policy purposes: the caller
    // treats it as "did not resolve" and refuses the destination.
    const addresses = [...new Set([...v4, ...v6])]
    cache.set(hostname, { expires: Date.now() + CACHE_TTL_MS, addresses })
    return addresses
  }
}
