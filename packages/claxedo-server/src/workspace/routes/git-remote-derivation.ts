/**
 * Pure derivation of a cloud-cloneable remote from `git remote -v` output.
 *
 * Two properties this module exists to guarantee, both asserted by test:
 *
 * 1. `url` is a transport URL that still clones, with the userinfo component
 *    removed. A GitHub token remote is `https://TOKEN@github.com/o/r.git` —
 *    the credential is the *username*, with no password — so http(s) drops the
 *    whole userinfo. SSH keeps its username (`git@`), which is the login name
 *    rather than a secret, and drops any password.
 * 2. `display` is rebuilt from host and path, never sliced out of the input, so
 *    a credential cannot survive into the string the setup screen renders.
 */

export type RemoteTransport = "https" | "ssh" | "local" | "other"

export type DerivedRemote = {
  name: string
  url: string
  display: string
  transport: RemoteTransport
  credentials_stripped: boolean
}

// `git@github.com:org/repo.git`. The negative lookahead keeps `https://…` out
// (its colon is followed by `//`), and requiring a dot in the host keeps
// `C:\repo` out.
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/\/)(.+)$/

const REMOTE_LINE = /^(\S+)\s+(.*?)\s+\((fetch|push)\)$/

function withoutGitSuffix(input: string) {
  return input.replace(/\.git$/, "")
}

function displayFrom(host: string, pathname: string) {
  const trimmed = withoutGitSuffix(pathname.replace(/^\/+/, ""))
  return trimmed ? `https://${host}/${trimmed}` : `https://${host}`
}

function scpLike(url: string) {
  const match = SCP_LIKE.exec(url)
  if (!match) return
  const [, user, host, pathname] = match
  if (!host?.includes(".")) return
  return {
    url: `${user ? `${user}@` : ""}${host}:${pathname}`,
    display: displayFrom(host, pathname ?? ""),
    transport: "ssh" as const,
    credentials_stripped: false,
  }
}

function urlLike(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return
  }
  const scheme = url.protocol.replace(/:$/, "")
  if (scheme === "file") {
    return {
      url: raw,
      display: url.pathname,
      transport: "local" as const,
      credentials_stripped: false,
    }
  }
  const web = scheme === "http" || scheme === "https"
  const ssh = scheme === "ssh" || scheme === "git+ssh"
  const hadUser = !!url.username
  const hadPassword = !!url.password
  // SSH is the only scheme whose username is known to be a login name rather
  // than a secret — a GitHub token remote puts the token in exactly that slot.
  // Every other scheme, recognized or not, loses its userinfo.
  if (!ssh || hadPassword) url.username = ""
  url.password = ""
  return {
    url: url.toString(),
    display: displayFrom(url.host, url.pathname),
    transport: web ? ("https" as const) : ssh ? ("ssh" as const) : ("other" as const),
    credentials_stripped: hadPassword || (hadUser && !ssh),
  }
}

function opaque(raw: string) {
  // URL-shaped but unparseable: scrub anything sitting in the userinfo slot
  // rather than hand it back intact.
  if (raw.includes("://")) {
    const scrubbed = raw.replace(/:\/\/[^/@]*@/, "://")
    return {
      url: scrubbed,
      display: scrubbed,
      transport: "other" as const,
      credentials_stripped: scrubbed !== raw,
    }
  }
  return {
    url: raw,
    display: raw,
    transport: "local" as const,
    credentials_stripped: false,
  }
}

export function sanitizeRemoteUrl(name: string, raw: string): DerivedRemote {
  const url = raw.trim()
  const parsed = urlLike(url) ?? scpLike(url) ?? opaque(url)
  return { name, ...parsed }
}

/**
 * `git remote -v` emits a fetch and a push line per remote. The fetch URL is
 * the one a clone uses, so a remote whose push URL differs is represented by
 * its fetch side and the push line is ignored.
 */
export function parseRemotes(output: string): DerivedRemote[] {
  const seen = new Map<string, DerivedRemote>()
  for (const line of output.split("\n")) {
    const match = REMOTE_LINE.exec(line.trim())
    if (!match) continue
    const [, name, url, direction] = match
    if (direction !== "fetch" || !name || !url) continue
    if (seen.has(name)) continue
    seen.set(name, sanitizeRemoteUrl(name, url))
  }
  return [...seen.values()]
}

export type RemoteDerivation =
  | { kind: "origin"; remote: DerivedRemote; remotes: DerivedRemote[] }
  | { kind: "ambiguous"; remotes: DerivedRemote[] }
  | { kind: "no_remote" }

export function deriveRemote(remotes: DerivedRemote[]): RemoteDerivation {
  if (remotes.length === 0) return { kind: "no_remote" }
  const origin = remotes.find((remote) => remote.name === "origin")
  if (origin) return { kind: "origin", remote: origin, remotes }
  return { kind: "ambiguous", remotes }
}
