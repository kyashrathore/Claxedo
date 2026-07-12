export const deepLinkEvent = "opencode:deep-link"

const parseUrl = (input: string) => {
  if (!input.startsWith("opencode://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

type NewSessionDeepLink = { directory: string; prompt?: string }

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is NewSessionDeepLink => !!link)

export function newSessionDeepLinkRoute(link: NewSessionDeepLink, routeFor: (value: string) => string) {
  const route = routeFor(link.directory)
  const prompt = link.prompt?.trim()
  if (!prompt) return route
  return `${route}${route.includes("?") ? "&" : "?"}prompt=${encodeURIComponent(prompt)}`
}

type DeepLinkWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: DeepLinkWindow) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
