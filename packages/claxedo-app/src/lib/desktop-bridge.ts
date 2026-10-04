import { isRecord } from "@claxedo/helpers/guards"
import { readField } from "@claxedo/helpers/readers"

export type DesktopBridge = {
  readonly openLink: (url: string) => void
  readonly readFileContent: (path: string) => Promise<unknown>
  readonly openPath: (path: string, app?: string) => Promise<void>
  readonly renderMermaid: (source: string, theme?: Record<string, string>) => Promise<string>
  readonly getWindowFullscreen: () => Promise<boolean>
  readonly onFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
}

const BRIDGE_METHODS: readonly (keyof DesktopBridge)[] = ["openLink", "readFileContent", "openPath", "renderMermaid", "getWindowFullscreen", "onFullscreenChange"]

function isDesktopBridge(api: unknown): api is DesktopBridge {
  return isRecord(api) && BRIDGE_METHODS.every((method) => typeof api[method] === "function")
}

export function desktopBridge(): DesktopBridge | undefined {
  const api = readField(globalThis, "api")
  return isDesktopBridge(api) ? api : undefined
}
