import { getFilename } from "@opencode-ai/util/path"
import { pagesApi } from "../../utils/pages-api"

type Tabs = {
  addPage: (pageId: string, title: string, directory?: string, filePath?: string) => string
  setActive: (tabId: string) => void
}

type Sdk = {
  client: {
    file: {
      read: (input: { path: string }) => Promise<{ data?: { content?: string } }>
    }
  }
}

function clean(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

function isPathLike(value: string) {
  if (!value) return false
  if (/^file:/i.test(value)) return true
  if (/^[a-z][a-z\d+\-.]*:/i.test(value)) return false
  if (value.startsWith("//")) return false
  return true
}

function normalizePath(path: string) {
  const value = path.replaceAll("\\", "/")
  const absolute = value.startsWith("/")
  const out = value.split("/").reduce<string[]>((list, part) => {
    if (!part || part === ".") return list
    if (part === "..") return list.slice(0, -1)
    return [...list, part]
  }, [])
  const joined = out.join("/")
  return absolute ? `/${joined}` : joined
}

function titleFromPath(filePath: string) {
  const name = getFilename(filePath)
  if (name) return name
  return "Untitled"
}

export function isMarkdownPath(path: string) {
  return /\.md(?:own)?$/i.test(clean(path))
}

export function markdownPathFromHref(raw: string) {
  const value = clean(raw)
  if (!isPathLike(value)) return ""
  const source = (() => {
    if (!/^file:/i.test(value)) return value
    try {
      return new URL(value).pathname || ""
    } catch {
      return value.replace(/^file:\/\/+/i, "/")
    }
  })()
  const [base] = source.split("#", 1)
  const [path] = base.split("?", 1)
  const decoded = (() => {
    try {
      return clean(decodeURIComponent(path))
    } catch {
      return clean(path)
    }
  })()
  if (!isMarkdownPath(decoded)) return ""
  return normalizePath(decoded)
}

export async function openMarkdownPageTab(input: { directory: string; path: string; sdk: Sdk; tabs: Tabs }) {
  const directory = clean(input.directory)
  const filePath = normalizePath(clean(input.path))
  if (!directory || !filePath || !isMarkdownPath(filePath)) return

  const title = titleFromPath(filePath)

  // Check if a page already exists for this file
  const existing = await pagesApi.findByFile(filePath, directory)
  const page = existing || (await pagesApi.create(title, filePath, directory))

  const tabId = input.tabs.addPage(page.id, page.title || title, directory, filePath)
  if (tabId) input.tabs.setActive(tabId)
}
