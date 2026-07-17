import { createSimpleContext } from "@opencode-ai/ui/context"
import { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
export type DesktopMenuAction =
  | "app.checkForUpdates"
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"
import { ServerConnection } from "@/platform/connection/server-connection"
import { configurePersistencePlatform } from "@/platform/persistence/persist"

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
  getStartAtLogin?(): Promise<boolean>
  setStartAtLogin?(enabled: boolean): Promise<void>
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
    configurePersistencePlatform(props.value)
    return props.value
  },
}
export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext<ReturnType<typeof platformContextInput.init>, { value: Platform }>(platformContextInput)
