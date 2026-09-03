import type { ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"

// Strict host allowlist: verify() sends `Basic base64(email:token)` to this
// host, so accepting arbitrary https origins would let a mistyped or
// attacker-suggested site_url exfiltrate the API token (and gives the server
// an SSRF primitive). Atlassian Cloud sites are always `<site>.atlassian.net`
// on the default port; self-hosted Data Center is out of scope for this
// reference impl (register your own impl for that).
const ATLASSIAN_HOST_SUFFIX = ".atlassian.net"

function normalizeSiteUrl(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:") return undefined
  if (url.port !== "") return undefined
  // Reject rather than silently drop embedded credentials, a query, or a
  // fragment. `url.origin` below would strip them, so accepting such a value
  // would quietly connect to a DIFFERENT place than the operator typed — and a
  // `user:pass@` prefix is the classic way to make a hostile URL read as a
  // trusted one. Any consumer that sends the stored credentials must apply the
  // same rule; the shared vectors in ./atlassian-site-url-vectors.ts are what
  // pin a second implementation to this one.
  if (url.username || url.password || url.search || url.hash) return undefined
  const host = url.hostname
  if (!host.endsWith(ATLASSIAN_HOST_SUFFIX)) return undefined
  const site = host.slice(0, -ATLASSIAN_HOST_SUFFIX.length)
  // Require exactly one non-empty DNS label before the suffix (defeats
  // "atlassian.net" bare and keeps the shape to `<site>.atlassian.net`).
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(site)) return undefined
  return url.origin
}

export function atlassianIntegration(options: IntegrationFetchOptions = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = timeoutFetch(options)
  return {
    decl: {
      id: "atlassian",
      name: "Atlassian",
      methods: ["key"],
      capabilities: ["docs", "work-source"],
      keyTokenType: "basic",
      prompts: [
        { id: "site_url", label: "Site URL", placeholder: "https://your-team.atlassian.net" },
        { id: "email", label: "Account email" },
        { id: "token", label: "API token", secret: true },
      ],
    },
    impl: {
      async verify(fields: ConnectionFields, secret: string): Promise<VerifyResult> {
        const site = normalizeSiteUrl(fields.site_url ?? "")
        const email = (fields.email ?? "").trim()
        if (!site || !email) return { ok: false, reason: "unauthorized" }
        try {
          const basic = Buffer.from(`${email}:${secret}`).toString("base64")
          const res = await fetchImpl(`${site}/wiki/rest/api/user/current`, {
            headers: {
              Authorization: `Basic ${basic}`,
              Accept: "application/json",
            },
          })
          if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" }
          if (!res.ok) return { ok: false, reason: "network" }
          const body = (await res.json().catch(() => ({}))) as { displayName?: unknown }
          return {
            ok: true,
            ...(typeof body.displayName === "string" ? { accountLabel: body.displayName } : {}),
            // Persist the origin this call actually authenticated against, not
            // the raw string the caller typed. Consumers then read a value that
            // already satisfies the strict rule instead of re-deriving it.
            fields: { site_url: site },
          }
        } catch {
          return { ok: false, reason: "network" }
        }
      },
    },
  }
}

export { normalizeSiteUrl }
