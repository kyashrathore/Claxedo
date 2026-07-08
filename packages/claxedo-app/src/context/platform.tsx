import { createSimpleContext } from "@opencode-ai/ui/context"
import { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "@/context/server"

type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

export type Platform = {
  platform: PlatformName
  os?: DesktopOS
  version?: string
  openLink(url: string): void
  openPath?(path: string, app?: string): Promise<void>
  restart(): Promise<void>
  quit?(): Promise<void>
  back(): void
  forward(): void
  notify(title: string, description?: string, href?: string): Promise<void>
  openDirectoryPickerDialog?(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>
  openFilePickerDialog?(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>
  saveFilePickerDialog?(opts?: { title?: string; defaultPath?: string }): Promise<string | null>
  storage?: (name?: string) => SyncStorage | AsyncStorage
  checkUpdate?(): Promise<{ updateAvailable: boolean; version?: string }>
  updateAndRestart?(): Promise<void>
  fetch?: typeof fetch
  getDefaultServer?(): Promise<ServerConnection.Key | null> | ServerConnection.Key | null
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void
  parseMarkdown?(markdown: string): Promise<string>
  renderMermaid?(source: string): Promise<string>
  webviewZoom?: Accessor<number>
  getPinchZoomEnabled?(): Promise<boolean> | boolean
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void
  checkAppExists?(appName: string): Promise<boolean>
  readClipboardImage?(): Promise<File | null>
  exportDebugLogs?(): Promise<string>
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
  getAuthToken?(): Promise<string | null>
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void
}

const platformContextInput = {
  name: "Platform", gate: true,
  init: (props: { value: Platform }) => {
    return props.value
  },
}
export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext<ReturnType<typeof platformContextInput.init>, { value: Platform }>(platformContextInput)
