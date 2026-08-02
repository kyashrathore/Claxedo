import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

/**
 * The git remote a picked folder would be cloned from, read from the local-only
 * `GET /api/claxedo/project/remote` route (plan 2026-07-31-001 §4.2).
 *
 * `display` is the ONLY render-safe string. The server rebuilds it from host and
 * path so a credential embedded in the remote cannot survive into it; `url` is
 * the transport URL that still clones and is passed onward, never shown.
 */
export type DerivedRemoteTransport = "https" | "ssh" | "local" | "other"

export type DerivedRemote = {
  name: string
  url: string
  display: string
  transport: DerivedRemoteTransport
  credentialsStripped: boolean
}

export type ProjectRemoteResult =
  | { kind: "origin"; remote: DerivedRemote; remotes: readonly DerivedRemote[] }
  | { kind: "ambiguous"; remotes: readonly DerivedRemote[] }
  | { kind: "no_remote" }
  | { kind: "not_a_repo" }
  | { kind: "git_timeout" }
  /** The route is absent or unreachable — distinct from "this folder has none". */
  | { kind: "unavailable" }

export type ProjectRemoteFetch = (url: string) => Promise<Response>

export async function readProjectRemote(input: {
  /**
   * An absolute filesystem path to read git remotes from — never a workspace
   * routing identity, which is what a `directory` string means elsewhere in
   * this app. The wire parameter is still named `directory` to match the route.
   */
  projectPath: string
  serverUrl?: string
  fetch?: ProjectRemoteFetch
}): Promise<ProjectRemoteResult> {
  const url = new URL("/api/claxedo/project/remote", normalizeUrl(input.serverUrl) ?? getClaxedoServerUrl())
  url.searchParams.set("directory", input.projectPath)
  try {
    const response = await (input.fetch ?? globalThis.fetch)(url.toString())
    // A 400 means we asked wrongly (relative path, empty directory). The user
    // did nothing repairable, so it reads as "cloud is unavailable for this
    // folder" rather than as a raw server code.
    if (!response.ok) return { kind: "unavailable" }
    return parseProjectRemote(await response.json())
  } catch {
    return { kind: "unavailable" }
  }
}

export function parseProjectRemote(value: unknown): ProjectRemoteResult {
  if (!value || typeof value !== "object") return { kind: "unavailable" }
  const body = value as Record<string, unknown>
  if (body.kind === "no_remote" || body.kind === "not_a_repo" || body.kind === "git_timeout") {
    return { kind: body.kind }
  }
  if (body.kind === "origin") {
    const remote = parseRemote(body.remote)
    if (!remote) return { kind: "unavailable" }
    return { kind: "origin", remote, remotes: parseRemotes(body.remotes) }
  }
  if (body.kind === "ambiguous") {
    const remotes = parseRemotes(body.remotes)
    // Ambiguous with nothing to pick from is not a choice we can present.
    if (remotes.length === 0) return { kind: "no_remote" }
    return { kind: "ambiguous", remotes }
  }
  return { kind: "unavailable" }
}

function parseRemotes(value: unknown): DerivedRemote[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const remote = parseRemote(item)
    return remote ? [remote] : []
  })
}

function parseRemote(value: unknown): DerivedRemote | undefined {
  if (!value || typeof value !== "object") return
  const remote = value as Record<string, unknown>
  if (typeof remote.name !== "string" || typeof remote.url !== "string") return
  // A remote with no `display` is dropped rather than shown: falling back to
  // `url` is exactly how an embedded credential would reach the screen.
  if (typeof remote.display !== "string" || !remote.display) return
  return {
    name: remote.name,
    url: remote.url,
    display: remote.display,
    transport: isTransport(remote.transport) ? remote.transport : "other",
    credentialsStripped: remote.credentials_stripped === true,
  }
}

function isTransport(value: unknown): value is DerivedRemoteTransport {
  return value === "https" || value === "ssh" || value === "local" || value === "other"
}

export type ProjectRemoteCopy = {
  /** What the screen says about this folder's cloud readiness. */
  message: string
  /** Whether the user can proceed to a cloud workspace from here. */
  cloudReady: boolean
  /** Offer the manual repo-URL field. */
  offerManualUrl: boolean
  /** Offer a retry of the derivation. */
  offerRetry: boolean
}

/**
 * Never surface a raw server kind. Each case gets a sentence that says what
 * happened and what the user can do next.
 */
export function projectRemoteCopy(result: ProjectRemoteResult): ProjectRemoteCopy {
  if (result.kind === "origin") {
    return {
      message: "This folder's origin remote is what cloud agents will clone. Confirm it before anything is created.",
      cloudReady: true,
      offerManualUrl: false,
      offerRetry: false,
    }
  }
  if (result.kind === "ambiguous") {
    return {
      message: "This folder has no remote named origin, so there is nothing to guess from. Pick the one to clone.",
      cloudReady: false,
      offerManualUrl: true,
      offerRetry: false,
    }
  }
  if (result.kind === "no_remote") {
    return {
      message:
        "This folder is a git repository with no remote, so there is nothing for a cloud sandbox to clone. Add a remote, or paste a repository URL to clone instead.",
      cloudReady: false,
      offerManualUrl: true,
      offerRetry: false,
    }
  }
  if (result.kind === "not_a_repo") {
    return {
      message:
        "This folder isn't a git repository, so cloud agents have nothing to clone. Local agents work here either way — or paste a repository URL for the cloud to use.",
      cloudReady: false,
      offerManualUrl: true,
      offerRetry: false,
    }
  }
  if (result.kind === "git_timeout") {
    return {
      message: "Reading this folder's git remotes took too long, so we stopped rather than guess. Try again.",
      cloudReady: false,
      offerManualUrl: true,
      offerRetry: true,
    }
  }
  return {
    message: "Couldn't read this folder's git remotes. Paste a repository URL for cloud agents to clone, or try again.",
    cloudReady: false,
    offerManualUrl: true,
    offerRetry: true,
  }
}

/**
 * Hosts whose public repositories clone with no credential at all. Anything
 * else — including a private repo on one of these — needs rights we cannot
 * check from here.
 */
const publicCloneHosts = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]

/**
 * Whether a cloud clone of this remote is known to need no credential.
 *
 * We cannot resolve clone RIGHTS client-side: a `https://github.com/o/r` URL is
 * shaped identically whether the repo is public or private, and asking the host
 * would mean making an unauthenticated request on the user's behalf. So this is
 * deliberately a statement about TRANSPORT, not about access — an SSH remote
 * always needs a key the sandbox does not have, and an HTTPS remote on a known
 * host needs nothing only if the repo happens to be public.
 */
export function cloneAccessNote(remote: DerivedRemote) {
  if (remote.transport === "ssh") {
    return "This is an SSH remote. A cloud sandbox has no SSH key, so cloning it needs a connection or an access token."
  }
  if (remote.transport === "local" || remote.transport === "other") {
    return "This remote isn't reachable from a cloud sandbox — it points somewhere only this machine can see."
  }
  const host = hostOf(remote.display)
  if (!host || !publicCloneHosts.includes(host)) {
    return "Cloud agents clone this over HTTPS. If the repository isn't public, that needs a connection or an access token."
  }
  return "If this repository is private, cloning it into a sandbox needs a connection or an access token. Public repositories need nothing."
}

function hostOf(display: string) {
  try {
    return new URL(display).host.toLowerCase()
  } catch {
    return
  }
}
