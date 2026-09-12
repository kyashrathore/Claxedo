export const deepLinkEvent = "claxedo:deep-link"

const parseUrl = (input: string) => {
  if (!input.startsWith("claxedo://")) return undefined
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return undefined
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return undefined
  if (url.hostname !== "open-project") return undefined
  const directory = url.searchParams.get("directory")
  if (!directory) return undefined
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return undefined
  if (url.hostname !== "new-session") return undefined
  const directory = url.searchParams.get("directory")
  if (!directory) return undefined
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

type NewSessionDeepLink = { directory: string; prompt?: string }

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is NewSessionDeepLink => !!link)

export type SessionDeepLink = { sessionId: string; workspaceDirectory?: string; store?: string }

/**
 * A local session's deep link: `claxedo://open-session?…&session=<id>`.
 * `store` is the session's position on disk — the local daemon's runtime
 * sqlite db, the same fact a Codex rollout path carries — and `directory` is
 * the worktree the session runs in. Only `session` is required to open it.
 */
export const sessionDeepLink = (input: {
  workspaceDirectory: string
  sessionId: string
  store?: string
}) => {
  const url = new URL("claxedo://open-session")
  url.searchParams.set("directory", input.workspaceDirectory)
  if (input.store) url.searchParams.set("store", input.store)
  url.searchParams.set("session", input.sessionId)
  return url.toString()
}

export const parseSessionDeepLink = (input: string): SessionDeepLink | undefined => {
  const url = parseUrl(input)
  if (!url) return undefined
  if (url.hostname !== "open-session") return undefined
  const sessionId = url.searchParams.get("session")
  if (!sessionId) return undefined
  const workspaceDirectory = url.searchParams.get("directory") ?? undefined
  const store = url.searchParams.get("store") ?? undefined
  return { sessionId, workspaceDirectory, store }
}

export const collectSessionDeepLinks = (urls: string[]) =>
  urls.map(parseSessionDeepLink).filter((link): link is SessionDeepLink => !!link)

export function newSessionDeepLinkRoute(
  link: NewSessionDeepLink,
  workspaceId: string,
  routeFor: (workspaceId: string) => string,
) {
  const route = routeFor(workspaceId)
  const prompt = link.prompt?.trim()
  if (!prompt) return route
  return `${route}${route.includes("?") ? "&" : "?"}prompt=${encodeURIComponent(prompt)}`
}

type DeepLinkWindow = Window & {
  __CLAXEDO__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: DeepLinkWindow) => {
  const pending = target.__CLAXEDO__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__CLAXEDO__) target.__CLAXEDO__.deepLinks = []
  return pending
}
