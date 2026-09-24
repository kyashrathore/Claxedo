function trimmed(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined
}

export function apiOrigin(): string {
  return trimmed(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? window.location.origin
}

export function appOrigin(): string {
  return window.location.origin
}

export function serverIssuesSessions(): boolean {
  return import.meta.env.VITE_CLAXEDO_ISSUES_SESSIONS !== "0"
}
