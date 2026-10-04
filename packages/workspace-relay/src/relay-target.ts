import { isRecord } from "@claxedo/helpers/guards"
import { isRelayBacking, type RelayBacking } from "./auth"
import { isHostTunnelTarget } from "./host-tunnel-forwarding"

export type WorkspaceRelayTarget = {
  workspaceId: string
  hostId: string
  baseUrl: string
  backing: RelayBacking
}

export function parseWorkspaceRelayTarget(input: unknown): WorkspaceRelayTarget | undefined {
  if (!isRecord(input)) return undefined
  const row = input
  const { workspaceId, hostId, baseUrl } = row
  if (typeof workspaceId !== "string" || typeof hostId !== "string" || typeof baseUrl !== "string") return undefined
  // `access` is the retired spelling of the same fact. A payload carrying it
  // came from a control plane on the other side of the placement change, whose
  // `backing` may disagree with it; drop the target rather than pick one.
  if (row.access !== undefined) return undefined
  if (!isRelayBacking(row.backing)) return undefined
  if (!isAllowedRelayTargetBaseUrl({ baseUrl, backing: row.backing })) return undefined
  return {
    workspaceId,
    hostId,
    baseUrl,
    backing: row.backing,
  }
}

function parseAbsoluteHttpUrl(baseUrl: string): URL | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
}

/**
 * The only destinations a `cloud-vm` target may reach over plaintext HTTP:
 * loopback, where the Relay Host Token on the request cannot leave the
 * machine. `127.0.0.0/8` is matched on the URL-normalised hostname — WHATWG
 * parsing already canonicalises `127.1`/`0177.0.0.1` forms — and each octet
 * is range-checked so a literal `127.999.1.1` hostname stays untrusted.
 */
function isLoopbackTargetHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost")) return true
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!ipv4 && ipv4.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * Whether a resolved target's `baseUrl` names a destination the relay may
 * forward to.
 *
 * A `cloud-vm` target is fetched over the network with the Relay Host Token
 * attached, so it must be HTTPS — or HTTP to a loopback host, the only
 * plaintext transport that cannot put the token on a network. A
 * `local-worktree` target is reached over the host tunnel and its `baseUrl` is
 * never fetched — the control plane sends the empty string — so only that
 * placeholder or a well-formed HTTP(S) URL is admitted. A `durable-object`
 * target is reached through the relay's own Durable Object binding, so it
 * names no destination at all.
 */
export function isAllowedRelayTargetBaseUrl(target: { baseUrl: string; backing: RelayBacking }): boolean {
  if (target.backing === "durable-object") return target.baseUrl === ""
  if (isHostTunnelTarget(target)) {
    if (target.baseUrl === "") return true
    return parseAbsoluteHttpUrl(target.baseUrl) !== undefined
  }
  const url = parseAbsoluteHttpUrl(target.baseUrl)
  if (!url) return false
  return url.protocol === "https:" || isLoopbackTargetHostname(url.hostname)
}
