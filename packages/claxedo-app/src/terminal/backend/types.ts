import type { TerminalCheckpoint } from "@claxedo/workspace-runtime/client"
import type { TerminalSize } from "@/server"
import type { Disposer } from "@/shell"
import type { RendererBudget } from "./renderer-budget"

export type TerminalColors = {
  readonly background: string
  readonly foreground: string
  readonly cursor: string
  readonly selectionBackground: string
}

export type FileLinkClick = (path: string, line?: number, col?: number, lineEnd?: number, colEnd?: number) => void

export type TerminalBackendOptions = {
  readonly theme: TerminalColors
  readonly fontFamily: string
  readonly screenReaderMode: boolean
  readonly renderers: RendererBudget
  readonly image?: "path" | "paste"
  readonly onSplitVertical?: () => void
  readonly onSplitHorizontal?: () => void
  readonly onFileLinkClick?: FileLinkClick
  readonly onUrlClick?: (event: MouseEvent, url: string) => void
}

export type TerminalBackend = {
  readonly cols: number
  readonly rows: number
  readonly textarea: HTMLTextAreaElement | null
  readonly element: HTMLElement | null
  write(data: string, callback?: () => void): void
  restoreCheckpoint(checkpoint: TerminalCheckpoint): Promise<void>
  onData(fn: (data: string) => void): Disposer
  onKey(fn: (event: { key: string }) => void): Disposer
  onResize(fn: (size: TerminalSize) => void): Disposer
  setTheme(theme: TerminalColors): void
  getDefaultColors(): { foreground: number; background: number }
  setFontFamily(font: string): void
  setCursorBlink(blink: boolean): void
  setScreenReaderMode(enabled: boolean): void
  focus(): void
  getSelection(): string
  hasSelection(): boolean
  scrollToLine(line: number): void
  scrollToBottom(): void
  getViewportY(): number
  isAtBottom(): boolean
  resize(cols: number, rows: number): void
  fit(): void
  refresh(start: number, end: number): void
  serialize(options?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string
  isAltScreen(): boolean
  dispose(): void
}

export type CreateBackend = (container: HTMLDivElement, options: TerminalBackendOptions) => Promise<TerminalBackend>
