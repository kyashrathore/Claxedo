import { projectWorkspaceDirectories } from "@/features/workspaces/lib/workspace-display"
import { sessionRoute, workspaceRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceRouteId } from "@/platform/identity/workspace-route"

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

export type DeepLinkProject = {
  id?: string | null
  worktree: string
  sandboxes?: string[]
  workspaces?: Record<string, { id?: string | null; workspaceId?: string | null; directory?: string }>
}

/** What the user is shown before an unregistered directory becomes a project. */
export type DeepLinkOpenRequest = { directory: string; prompt?: string }

const windowsDrive = /^[A-Za-z]:[\\/]/

function collapsePathSegments(prefix: string, body: string, separator: "/" | "\\") {
  const segments: string[] = []
  for (const segment of body.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${prefix}${separator}${segments.join(separator)}`
}

/**
 * The directory a deep link names, as the project-create route will receive it
 * and as the confirmation will print it — one string for both, so the path the
 * user reads cannot differ from the path that gets registered.
 *
 * `.`, `..` and repeated separators are collapsed here rather than left to the
 * server: `/Users/me/repo/../../../etc` reads as a project directory and is
 * not one. Symlinks are not followed — no filesystem is reachable from the
 * renderer, and the link arrives from the OS scheme registry with no
 * main-process resolution behind it.
 *
 * Anything not already absolute is refused instead of resolved, because the
 * only base a relative path could take here is the server process's working
 * directory, which the user has no way to see.
 */
export function deepLinkDirectory(raw: string) {
  const trimmed = raw.trim()
  if (windowsDrive.test(trimmed)) return collapsePathSegments(trimmed.slice(0, 2), trimmed.slice(2), "\\")
  // A leading `//` is a UNC share on Windows and implementation-defined on
  // POSIX; collapsing it would silently rewrite the host segment into a
  // top-level directory name.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined
  return collapsePathSegments("", trimmed, "/")
}

/**
 * Whether the workbench's own project list already addresses this directory —
 * the same rows the rail, the router and every workspace query read, so a
 * project the user can already see never asks to be opened again.
 */
export function deepLinkProjectRegistered(projects: readonly DeepLinkProject[], directory: string) {
  return projects.some((project) =>
    projectWorkspaceDirectories(project).some((candidate) => deepLinkDirectory(candidate) === directory),
  )
}

/** Spelled out rather than taken from the dictionary type so a key this copy needs cannot be renamed away silently. */
type ConfirmTranslator = (
  key:
    | "dialog.deeplink.open.title"
    | "dialog.deeplink.open.body"
    | "dialog.deeplink.open.prompt"
    | "dialog.deeplink.open.confirm",
  vars?: Record<string, string>,
) => string

/**
 * What the confirmation says. The directory is printed exactly as
 * `deepLinkDirectory` produced it, because that same string is what the
 * project-create route receives. A link's prompt text is shown too: it is the
 * other thing the user cannot see before agreeing.
 */
export function deepLinkConfirmCopy(request: DeepLinkOpenRequest, t: ConfirmTranslator) {
  const directory = t("dialog.deeplink.open.body", { directory: request.directory })
  const prompt = request.prompt ? t("dialog.deeplink.open.prompt", { prompt: request.prompt }) : undefined
  return {
    title: t("dialog.deeplink.open.title"),
    body: prompt ? `${directory}\n\n${prompt}` : directory,
    confirmLabel: t("dialog.deeplink.open.confirm"),
  }
}

type DeepLinkTarget =
  | { request: DeepLinkOpenRequest; routeFor: (workspaceId: string) => string }
  | { request?: undefined; route: string }

function deepLinkTargets(urls: string[]) {
  const targets: DeepLinkTarget[] = []
  for (const raw of collectOpenProjectDeepLinks(urls)) {
    const directory = deepLinkDirectory(raw)
    if (!directory) continue
    targets.push({ request: { directory }, routeFor: workspaceRoute })
  }
  for (const link of collectNewSessionDeepLinks(urls)) {
    const directory = deepLinkDirectory(link.directory)
    if (!directory) continue
    const prompt = link.prompt?.trim()
    const request: DeepLinkOpenRequest = prompt ? { directory, prompt } : { directory }
    targets.push({
      request,
      routeFor: (workspaceId) => newSessionDeepLinkRoute(request, workspaceId, workspaceSessionRoute),
    })
  }
  for (const link of collectSessionDeepLinks(urls)) {
    const route = sessionRoute(link.sessionId)
    if (!link.workspaceDirectory) {
      targets.push({ route })
      continue
    }
    const directory = deepLinkDirectory(link.workspaceDirectory)
    if (!directory) continue
    // The route ignores the workspace id: `/s/<id>` is a local session's
    // canonical address however its workspace is addressed, and the project
    // open is rail context around it.
    targets.push({ request: { directory }, routeFor: () => route })
  }
  return targets
}

export type DeepLinkProjectOpener = {
  /** Whether the attached server runs on this machine, so a directory names one of its paths. */
  local: () => boolean
  projects: () => readonly DeepLinkProject[]
  confirm: (request: DeepLinkOpenRequest) => Promise<boolean>
  ensure: (directory: string) => Promise<readonly DeepLinkProject[] | undefined>
  open: (directory: string) => void
  navigate: (route: string) => void
}

/**
 * The one place a deep link turns into workbench state.
 *
 * Every `claxedo://` link is externally initiated: the OS scheme registry
 * hands it over, whether the user clicked it in a transcript (which leaves the
 * app through `shell.openExternal` and re-enters here) or a page elsewhere
 * opened it. So a directory the project list does not already address is
 * confirmed before anything creates it, and the answer gates creation itself
 * rather than only the navigation that follows.
 *
 * A link's prompt text reaches the route and stops there. `confirm`, `ensure`,
 * `open` and `navigate` are the opener's entire outward surface, so no deep
 * link can reach a send.
 */
export function createDeepLinkProjectOpener(deps: DeepLinkProjectOpener) {
  const openProject = async (request: DeepLinkOpenRequest, routeFor: (workspaceId: string) => string) => {
    let projects = deps.projects()
    if (!deepLinkProjectRegistered(projects, request.directory) && !(await deps.confirm(request))) return
    const ensured = await deps.ensure(request.directory)
    if (ensured) projects = ensured
    const workspaceId = workspaceRouteId(projects, request.directory)
    if (!workspaceId) return
    deps.open(request.directory)
    deps.navigate(routeFor(workspaceId))
  }

  return async (urls: string[]) => {
    if (!deps.local()) return
    // Sequential: a batch can name the same directory twice, and a second
    // confirmation for a project the first one just created would be a prompt
    // for something already done.
    for (const target of deepLinkTargets(urls)) {
      if (!target.request) {
        deps.navigate(target.route)
        continue
      }
      await openProject(target.request, target.routeFor)
    }
  }
}
