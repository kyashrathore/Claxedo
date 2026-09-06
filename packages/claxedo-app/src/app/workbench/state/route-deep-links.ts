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
