import { watchRealDirectory } from "@claxedo/helpers/real-path"

export const PLUGIN_WATCH_DEBOUNCE_MS = 300

const IGNORED_SEGMENTS = new Set(["node_modules", "dist", ".git"])

export function isIgnoredPluginPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment))
}

export type PluginFolderWatch = {
  close(): void
}

export type PluginFolderWatchOptions = {
  rootDir: string
  onChange(files: readonly string[]): void
  onError(error: Error): void
  debounceMs?: number
}

export function watchPluginFolder(options: PluginFolderWatchOptions): PluginFolderWatch {
  const debounceMs = options.debounceMs ?? PLUGIN_WATCH_DEBOUNCE_MS
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const flush = () => {
    timer = undefined
    if (closed || pending.size === 0) return
    const files = [...pending].sort()
    pending.clear()
    options.onChange(files)
  }
  const watcher = watchRealDirectory(options.rootDir, { recursive: true, persistent: false }, (_event, filename) => {
    if (closed || filename === null || isIgnoredPluginPath(filename)) return
    pending.add(filename)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
    timer.unref()
  })
  watcher.on("error", (error) => options.onError(error))
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      pending.clear()
      watcher.close()
    },
  }
}
