import { bracketed } from "./clipboard"
import { objectProperty } from "./reflect"

export type DropOptions = {
  readonly image?: "path" | "paste"
  readonly onWrite: (data: string) => void
  readonly bracketedPaste: () => boolean
}

function desktopApi(): unknown {
  if (typeof window === "undefined") return undefined
  return objectProperty(window, "api")
}

export function parseFileUris(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file://"))
    .map((uri) => {
      const path = decodeURIComponent(uri.replace(/^file:\/\//, ""))
      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
    })
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/")
}

async function writeImage(file: File): Promise<boolean> {
  const write = objectProperty(desktopApi(), "writeClipboardImage")
  if (typeof write !== "function") return false
  const bytes = await file.arrayBuffer()
  return write(bytes) === true
}

function desktopPaths(api: unknown, files: File[]): string[] {
  const resolve = objectProperty(api, "getDroppedFilePaths")
  if (typeof resolve !== "function") return []
  const resolved = resolve(files)
  return Array.isArray(resolved) ? resolved.filter((item): item is string => typeof item === "string") : []
}

async function pasteImages(files: File[], options: DropOptions): Promise<boolean> {
  let pasted = false
  for (const file of files) {
    if (!(await writeImage(file))) continue
    pasted = true
    options.onWrite("\x16")
  }
  return pasted
}

async function writePaths(paths: string[], options: DropOptions): Promise<void> {
  const { quote } = await import("shell-quote")
  const escaped = paths.map((path) => quote([path])).join(" ")
  options.onWrite(bracketed(escaped, options.bracketedPaste()))
}

export function setupDrop(container: HTMLDivElement, options: DropOptions): () => void {
  const handleDragOver = (event: DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  }
  const handleDrop = (event: DragEvent) => {
    event.preventDefault()
    const transfer = event.dataTransfer
    if (!transfer) return
    const files = Array.from(transfer.files ?? [])
    const api = desktopApi()
    const desktop = !!api && files.length > 0
    const uriList = transfer.getData("text/uri-list")
    const uriPaths = uriList ? parseFileUris(uriList) : []
    const canPaste = desktop && (options.image ?? "path") === "paste" && files.every(isImage)
    if (!desktop && uriPaths.length === 0 && !canPaste) return
    event.stopPropagation()
    void (async () => {
      if (canPaste && (await pasteImages(files, options))) return
      const paths = desktop ? desktopPaths(api, files) : []
      const targets = paths.length > 0 ? paths : uriPaths
      if (targets.length > 0) await writePaths(targets, options)
    })()
  }
  container.addEventListener("dragover", handleDragOver)
  container.addEventListener("drop", handleDrop)
  return () => {
    container.removeEventListener("dragover", handleDragOver)
    container.removeEventListener("drop", handleDrop)
  }
}
