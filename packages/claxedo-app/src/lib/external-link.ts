import { desktopBridge } from "./desktop-bridge"

export function openExternal(url: string): void {
  const bridge = desktopBridge()
  if (bridge) return bridge.openLink(url)
  window.open(url, "_blank", "noopener,noreferrer")
}
