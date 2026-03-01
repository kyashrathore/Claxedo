import { getFilename } from "@opencode-ai/util/path"
import { pagesApi } from "../../utils/pages-api"

type Tabs = {
  addPage: (pageId: string, title: string, directory?: string) => string
  setActive: (tabId: string) => void
}

type Sdk = {
  client: {
    file: {
      read: (input: { path: string }) => Promise<{ data?: { content?: string } }>
    }
  }
}

const storeKey = "claxedo.pages.markdown-links.v1"

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

function readStore() {
  if (typeof window === "undefined" || !window.localStorage) return {}
  const raw = window.localStorage.getItem(storeKey)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function writeStore(next: Record<string, string>) {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    window.localStorage.setItem(storeKey, JSON.stringify(next))
  } catch {}
}

function storageKey(directory: string, filePath: string) {
  return `${clean(directory)}::${normalizePath(filePath).toLowerCase()}`
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
  const path = normalizePath(clean(input.path))
  if (!directory || !path || !isMarkdownPath(path)) return

  const key = storageKey(directory, path)
  const map = readStore()
  const linked = clean(map[key])

  const content = clean((await input.sdk.client.file.read({ path })).data?.content)
  const title = titleFromPath(path)
  const page = linked ? await pagesApi.get(linked).catch(() => pagesApi.create(title)) : await pagesApi.create(title)

  if (content) {
    await pagesApi.importMarkdown(page.id, content, true).catch(async () => {
      await pagesApi.update(page.id, { title })
    })
  } else {
    await pagesApi.update(page.id, { title, content: "" }).catch(() => {})
  }

  map[key] = page.id
  writeStore(map)
  const tabId = input.tabs.addPage(page.id, page.title || title, directory)
  if (tabId) input.tabs.setActive(tabId)
}
