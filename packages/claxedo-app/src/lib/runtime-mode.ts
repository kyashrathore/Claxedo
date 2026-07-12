export function isDemoPath(path: string) {
  return path === "/demo" || path.startsWith("/demo/")
}

export function isDemoMode() {
  if (typeof window === "undefined") return false
  return isDemoPath(window.location.pathname)
}

export function isEmbedMode() {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("embed")
}
