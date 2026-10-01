import { readField } from "@claxedo/helpers/readers"

export type DesktopBridge = {
  readonly openLink: (url: string) => void
  readonly renderMermaid: (source: string, theme?: Record<string, string>) => Promise<string>
}

export function desktopBridge(): DesktopBridge | undefined {
  const api: unknown = (globalThis as { api?: unknown }).api
  return typeof api === "object" && api !== null ? (api as DesktopBridge) : undefined
}

export function desktopMachineReport(): (() => Promise<unknown>) | undefined {
  const connector = readField(desktopBridge(), "hostConnector")
  const status = readField(connector, "status")
  if (typeof status !== "function") return undefined
  return async (): Promise<unknown> => Reflect.apply(status, connector, [])
}
