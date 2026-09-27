function trimmed(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined
}

export function apiOrigin(): string {
  return trimmed(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? window.location.origin
}

export function appOrigin(): string {
  return window.location.origin
}

export function appUrl(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  return new URL(`${location.pathname}${location.search}${location.hash}`, appOrigin()).href
}

export function serverIssuesSessions(): boolean {
  return import.meta.env.VITE_CLAXEDO_ISSUES_SESSIONS !== "0"
}
