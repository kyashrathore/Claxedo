type LinkBridge = { readonly openLink: (url: string) => void }

function linkBridge(): LinkBridge | undefined {
  const api: unknown = (globalThis as { api?: unknown }).api
  if (typeof api !== "object" || api === null) return undefined
  return typeof (api as { openLink?: unknown }).openLink === "function" ? (api as LinkBridge) : undefined
}

export function openExternal(url: string): void {
  const bridge = linkBridge()
  if (bridge) return bridge.openLink(url)
  window.open(url, "_blank", "noopener,noreferrer")
}
