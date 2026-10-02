import { isRecord } from "@claxedo/helpers/guards"
import { readField } from "@claxedo/helpers/readers"

export type DesktopBridge = {
  readonly openLink: (url: string) => void
  readonly renderMermaid: (source: string, theme?: Record<string, string>) => Promise<string>
}

function isDesktopBridge(api: unknown): api is DesktopBridge {
  return isRecord(api) && typeof api.openLink === "function" && typeof api.renderMermaid === "function"
}

export function desktopBridge(): DesktopBridge | undefined {
  const api = readField(globalThis, "api")
  return isDesktopBridge(api) ? api : undefined
}

export function desktopMachineReport(): (() => Promise<unknown>) | undefined {
  const connector = readField(desktopBridge(), "hostConnector")
  const status = readField(connector, "status")
  if (typeof status !== "function") return undefined
  return async (): Promise<unknown> => Reflect.apply(status, connector, [])
}
