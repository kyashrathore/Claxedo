export function appOrigin(): string {
  return window.location.origin
}

/** Where this browser reaches every relay room: its own origin forwards `/relay` to the relay, so no request leaves the page's origin. */
export function relayUrl(): string {
  return `${appOrigin()}/relay`
}

export function appUrl(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  return new URL(`${location.pathname}${location.search}${location.hash}`, appOrigin()).href
}

export function serverIssuesSessions(): boolean {
  return import.meta.env.VITE_CLAXEDO_ISSUES_SESSIONS !== "0"
}
