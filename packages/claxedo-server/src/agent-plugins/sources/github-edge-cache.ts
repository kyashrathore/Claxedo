import type { AgentPluginSourceFetch } from "@claxedo/server-core/agent-plugins/sources/github-public"

/**
 * The GitHub fetches a catalog read makes, cached at the edge across isolates.
 *
 * A Worker isolate is short-lived, so the provider's in-memory memo rarely
 * survives between two reads and every cold read paid a ref lookup plus an
 * archive download before the marketplace could paint. The archive for a
 * commit is immutable, so it is cached for a day; the ref lookup is what
 * moves, so it is cached for a minute — a push shows up within that minute
 * and "Refresh catalog" still bypasses nothing here (it re-lists, and the
 * minute-old ref answer is the freshest the collection can be anyway).
 *
 * Anything that is not one of those two GitHub GETs goes straight through.
 */
import { edgeCachedFetch, type EdgeCache } from "../edge-cached-fetch"

export type { EdgeCache }

const REF_LOOKUP_TTL_SECONDS = 60
const ARCHIVE_TTL_SECONDS = 86_400

function githubPolicy(url: URL): { ttlSeconds: number } | undefined {
  if (url.hostname === "api.github.com" && /^\/repos\/[^/]+\/[^/]+\/commits\//.test(url.pathname)) return { ttlSeconds: REF_LOOKUP_TTL_SECONDS }
  if (url.hostname === "codeload.github.com" && /^\/[^/]+\/[^/]+\/zip\/[a-f0-9]{40}$/.test(url.pathname)) return { ttlSeconds: ARCHIVE_TTL_SECONDS }
  return undefined
}

export function githubEdgeCachedFetch(input: {
  /** Resolved per call: `caches.default` exists only inside a Worker isolate. */
  cache: () => EdgeCache | undefined
  fetch?: AgentPluginSourceFetch
  /** Keeps the write alive past the response when a Worker context is available. */
  waitUntil?: (work: Promise<unknown>) => void
}): AgentPluginSourceFetch {
  return edgeCachedFetch({ ...input, policy: githubPolicy })
}
