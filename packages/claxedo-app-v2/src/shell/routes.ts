import { placementId, sessionId, terminalId } from "@/server"
import type { PlacementId, SessionId, SessionRef, TerminalId } from "@/server"
import type { PageEntry, RouteEntry } from "./types"

export type RouteParams = Readonly<Record<string, string>>

export type ShellRoute =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly placementId: PlacementId; readonly sessionId: SessionId }
  | { readonly kind: "terminal"; readonly placementId: PlacementId; readonly terminalId: TerminalId }
  | { readonly kind: "page"; readonly page: PageEntry; readonly params: RouteParams }
  | { readonly kind: "screen"; readonly screen: RouteEntry; readonly params: RouteParams }
  | { readonly kind: "unknown"; readonly path: string }

export const homePath = "/"

export function sessionPath(ref: Pick<SessionRef, "placementId" | "sessionId">): string {
  return `/w/${encodeURIComponent(ref.placementId)}/s/${encodeURIComponent(ref.sessionId)}`
}

export function terminalPath(placement: PlacementId, terminal: TerminalId): string {
  return `/w/${encodeURIComponent(placement)}/t/${encodeURIComponent(terminal)}`
}

export function settingsPath(section?: string): string {
  return section ? `/settings/${encodeURIComponent(section)}` : "/settings"
}

function segments(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

export function matchPattern(pattern: string, path: string): RouteParams | undefined {
  const expected = segments(pattern)
  const actual = segments(path)
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index]
    const value = actual[index]
    if (part.startsWith("*")) {
      params[part.slice(1)] = actual.slice(index).map(decodeURIComponent).join("/")
      return params
    }
    if (part.startsWith(":")) {
      const optional = part.endsWith("?")
      if (value === undefined) return optional ? params : undefined
      params[part.slice(1, optional ? -1 : undefined)] = decodeURIComponent(value)
      continue
    }
    if (value !== part) return undefined
  }
  return actual.length === expected.length ? params : undefined
}

export function fillPattern(pattern: string, params: RouteParams = {}): string {
  const filled = segments(pattern).flatMap((part) => {
    if (part.startsWith("*")) return params[part.slice(1)] ? [params[part.slice(1)]] : []
    if (!part.startsWith(":")) return [part]
    const value = params[part.slice(1, part.endsWith("?") ? -1 : undefined)]
    return value === undefined ? [] : [encodeURIComponent(value)]
  })
  return `/${filled.join("/")}`
}

function specificity(pattern: string): number {
  return segments(pattern).filter((part) => !part.startsWith(":") && !part.startsWith("*")).length
}

export function parseRoute(
  pathname: string,
  pages: readonly PageEntry[],
  screens: readonly RouteEntry[],
): ShellRoute {
  for (const screen of screens) {
    const params = matchPattern(screen.path, pathname)
    if (params) return { kind: "screen", screen, params }
  }
  if (pathname === "/" || pathname === "") return { kind: "home" }
  const session = matchPattern("/w/:placementId/s/:sessionId", pathname)
  if (session) return { kind: "session", placementId: placementId(session.placementId), sessionId: sessionId(session.sessionId) }
  const terminal = matchPattern("/w/:placementId/t/:terminalId", pathname)
  if (terminal) {
    return { kind: "terminal", placementId: placementId(terminal.placementId), terminalId: terminalId(terminal.terminalId) }
  }
  const ordered = [...pages].sort((a, b) => specificity(b.path) - specificity(a.path))
  for (const page of ordered) {
    const params = matchPattern(page.path, pathname)
    if (params) return { kind: "page", page, params }
  }
  return { kind: "unknown", path: pathname }
}

export function routePlacementId(route: ShellRoute): PlacementId | undefined {
  return route.kind === "session" || route.kind === "terminal" ? route.placementId : undefined
}

export function sidebarModeOf(route: ShellRoute): "main" | "settings" {
  return route.kind === "page" ? route.page.sidebar : "main"
}
