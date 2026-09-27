export type DesktopBridge = {
  readonly openLink: (url: string) => void
  readonly renderMermaid: (source: string, theme?: Record<string, string>) => Promise<string>
}

export function desktopBridge(): DesktopBridge | undefined {
  const api: unknown = (globalThis as { api?: unknown }).api
  return typeof api === "object" && api !== null ? (api as DesktopBridge) : undefined
}
