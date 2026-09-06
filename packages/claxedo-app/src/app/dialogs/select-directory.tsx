// Claxedo owns directory search while routing hosted app requests through the local loopback bridge.
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useLayout } from "@/app/providers/layout"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { cachedDirectoryChildrenRequest } from "@/platform/query/directory-search-cache"
import { ClaxedoIconV2 } from "@/ui/controls/claxedo-icon"
import { useCheckServerHealth } from "@/app/connection/server-health"
import { onlyStrings, readString } from "@/lib/record"
import {
  workspaceRuntimeFilePath,
  workspaceRuntimeFindFilePath,
} from "@/platform/runtime/agent/dialog-select-directory-routes"

interface DialogSelectDirectoryProps {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

type Row = {
  absolute: string
  search: string
  group: "recent" | "folders"
}

type DirectoryEntry = {
  name: string
  absolute: string
  type?: string
}

/**
 * The rows a local file listing carries, as this picker reads them.
 *
 * A row without both a name and an absolute path cannot be offered as a folder
 * — it would render as a blank entry the user can select — so it is dropped
 * here rather than named as a `DirectoryEntry[]` the response never proved.
 */
function directoryEntries(body: unknown): DirectoryEntry[] {
  return (Array.isArray(body) ? body : []).flatMap((item) => {
    const name = readString(item, "name")
    const absolute = readString(item, "absolute")
    if (name === undefined || absolute === undefined) return []
    const type = readString(item, "type")
    return [{ name, absolute, ...(type === undefined ? {} : { type }) }]
  })
}

function cleanInput(value: string) {
  return ((value ?? "").split(/\r?\n/)[0] ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

function isLoopbackUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "http:" && (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    )
  } catch {
    return false
  }
}

function localRequest(url: string, request?: typeof fetch) {
  if (isLoopbackUrl(url)) return fetch
  return request ?? fetch
}

function normalizePath(input: string) {
  const v = input.replaceAll("\\", "/")
  if (v.startsWith("//") && !v.startsWith("///")) return "//" + v.slice(2).replace(/\/+/g, "/")
  return v.replace(/\/+/g, "/")
}

function normalizeDriveRoot(input: string) {
  const v = normalizePath(input)
  if (/^[A-Za-z]:$/.test(v)) return v + "/"
  return v
}

function trimTrailing(input: string) {
  const v = normalizeDriveRoot(input)
  if (v === "/" || v === "//" || /^[A-Za-z]:\/$/.test(v)) return v
  return v.replace(/\/+$/, "")
}

function joinPath(base: string | undefined, rel: string) {
  const b = trimTrailing(base ?? "")
  const r = trimTrailing(rel).replace(/^\/+/, "")
  if (!b) return r
  if (!r) return b
  return b.endsWith("/") ? b + r : b + "/" + r
}

function rootOf(input: string) {
  const v = normalizeDriveRoot(input)
  if (v.startsWith("//")) return "//"
  if (v.startsWith("/")) return "/"
  if (/^[A-Za-z]:\//.test(v)) return v.slice(0, 3)
  return ""
}

function parentOf(input: string) {
  const v = trimTrailing(input)
  if (v === "/" || v === "//" || /^[A-Za-z]:\/$/.test(v)) return v
  const i = v.lastIndexOf("/")
  if (i <= 0) return "/"
  if (i === 2 && /^[A-Za-z]:/.test(v)) return v.slice(0, 3)
  return v.slice(0, i)
}

function modeOf(input: string) {
  const raw = normalizeDriveRoot(input.trim())
  if (!raw) return "relative"
  if (raw.startsWith("~")) return "tilde"
  if (rootOf(raw)) return "absolute"
  return "relative"
}

function tildeOf(absolute: string, home: string) {
  const full = trimTrailing(absolute)
  if (!home) return ""
  const hn = trimTrailing(home)
  const lc = full.toLowerCase()
  const hc = hn.toLowerCase()
  if (lc === hc) return "~"
  if (lc.startsWith(hc + "/")) return "~" + full.slice(hn.length)
  return ""
}

function displayPath(path: string, input: string, home: string) {
  const full = trimTrailing(path)
  if (modeOf(input) === "absolute") return full
  return tildeOf(full, home) || full
}

function toRow(absolute: string, home: string, group: Row["group"]): Row {
  const full = trimTrailing(absolute)
  const tilde = tildeOf(full, home)
  const withSlash = (value: string) => value && !value.endsWith("/") ? value + "/" : value
  return {
    absolute: full,
    search: Array.from(new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean))).join("\n"),
    group,
  }
}

function uniqueRows(rows: Row[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}

function useDirectorySearch(args: {
  serverUrl: () => string
  request?: typeof fetch
  start: () => string | undefined
  home: () => string
  /**
   * Whether the server runs workspaces on its own filesystem (its health
   * report). A signed self-hosted server on `https://localhost` — or on a VM —
   * is not a loopback URL, yet its folders are exactly what this picker is
   * for; the URL shape alone only recognises the unsigned local product.
   */
  localExecution: () => Promise<boolean | undefined>
}) {
  let current = 0

  // Answers the body as `unknown`: the two callers below each read the shape
  // they need. The generic `json<T>(..., fallback)` this replaced let a caller
  // NAME the response shape, so an unreachable or malformed local runtime
  // handed the picker a value it then walked as if the server had confirmed it.
  const jsonBody = async (pathname: string, params: Record<string, string | number | undefined>): Promise<unknown> => {
    const serverUrl = args.serverUrl()
    if (!isLoopbackUrl(serverUrl) && !(await args.localExecution())) return undefined
    const url = new URL(pathname, serverUrl)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    const res = await localRequest(serverUrl, args.request)(url, {
      headers: { Accept: "application/json" },
    }).catch(() => undefined)
    if (!res?.ok) return undefined
    return await res.json().catch(() => undefined)
  }

  const scoped = (value: string) => {
    const raw = normalizeDriveRoot(value)
    // A root-anchored path names its own scope: it must not wait on the home
    // lookup (`start`), which can still be in flight when the user has
    // already typed an absolute path.
    const root = rootOf(raw)
    if (root) return { directory: trimTrailing(root), path: raw.slice(root.length) }
    const base = args.start()
    if (!base) return undefined
    if (!raw) return { directory: trimTrailing(base), path: "" }
    const home = args.home()
    if (raw === "~") return { directory: trimTrailing(home || base), path: "" }
    if (raw.startsWith("~/")) return { directory: trimTrailing(home || base), path: raw.slice(2) }
    return { directory: trimTrailing(base), path: raw }
  }

  const dirs = async (dir: string) => {
    const key = trimTrailing(dir)
    return cachedDirectoryChildrenRequest({
      serverUrl: args.serverUrl(),
      directory: key,
      list: () => jsonBody(
        workspaceRuntimeFilePath({ resource: "file", scope: key, path: "" }),
        {},
      ).then((body) =>
        directoryEntries(body)
          .filter((n) => n.type === "directory")
          .map((n) => ({ name: n.name, absolute: trimTrailing(normalizeDriveRoot(n.absolute)) })),
      ),
    })
  }

  const match = async (dir: string, query: string, limit: number) => {
    const items = await dirs(dir)
    if (!query) return items.slice(0, limit).map((x) => x.absolute)
    const needle = query.toLowerCase()
    return items
      .filter((item) => item.name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((x) => x.absolute)
  }

  return async (filter: string) => {
    const token = ++current
    const active = () => token === current
    const value = cleanInput(filter)
    const scopedInput = scoped(value)
    if (!scopedInput) return [] as string[]

    const raw = normalizeDriveRoot(value)
    const isPath = raw.startsWith("~") || !!rootOf(raw) || raw.includes("/")
    const query = normalizeDriveRoot(scopedInput.path)
    if (!isPath) {
      const results = onlyStrings(await jsonBody(
        workspaceRuntimeFindFilePath({
          scope: scopedInput.directory,
          query,
          type: "directory",
          limit: 50,
        }),
        {},
      ))
      if (!active()) return []
      return results.map((rel) => joinPath(scopedInput.directory, rel)).slice(0, 50)
    }

    const segments = query.replace(/^\/+/, "").split("/")
    const head = segments.slice(0, segments.length - 1).filter((x) => x && x !== ".")
    const tail = segments[segments.length - 1] ?? ""
    let paths = [scopedInput.directory]
    for (const part of head) {
      if (!active()) return []
      if (part === "..") {
        paths = paths.map(parentOf)
        continue
      }
      paths = Array.from(new Set((await Promise.all(paths.map((p) => match(p, part, 4)))).flat())).slice(0, 12)
      if (paths.length === 0) return []
    }

    const out = (await Promise.all(paths.map((p) => match(p, tail, 50)))).flat()
    if (!active()) return []
    const deduped = Array.from(new Set(out))
    const base = raw.startsWith("~") ? trimTrailing(scopedInput.directory) : ""
    if (raw.endsWith("/") || !tail) return (base ? Array.from(new Set([base, ...deduped])) : deduped).slice(0, 50)

    const target = deduped.find((p) => getFilename(p).toLowerCase() === tail.toLowerCase())
    if (!target) return deduped.slice(0, 50)
    const children = await match(target, "", 30)
    if (!active()) return []
    return (base ? Array.from(new Set([base, ...deduped, ...children])) : Array.from(new Set([...deduped, ...children]))).slice(0, 50)
  }
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const queryOptions = useQueryOptions()
  const sdk = useGlobalSDK()
  const layout = useLayout()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [filter, setFilter] = createSignal("")
  let list: ListRef | undefined

  const pathQuery = useQuery(() => queryOptions.path(null))
  const home = createMemo(() => pathQuery.data?.home || "")
  const start = createMemo(() => pathQuery.data?.home || pathQuery.data?.directory)
  const checkServerHealth = useCheckServerHealth()
  const directories = useDirectorySearch({
    serverUrl: () => sdk.url,
    request: platform.fetch,
    home,
    start,
    localExecution: () => checkServerHealth({ url: sdk.url }).then((health) => health?.localExecution).catch(() => undefined),
  })
  const recentProjects = createMemo(() =>
    layout.projects.list().slice(0, 5).map((project) => {
      const row = toRow(project.worktree, home(), "recent")
      return { ...row, search: `${row.search}\n${project.name || getFilename(project.worktree)}` }
    }),
  )
  const items = async (value: string) =>
    uniqueRows([...recentProjects(), ...(await directories(value)).map((absolute) => toRow(absolute, home(), "folders"))])

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  return (
    <Dialog
      flush
      title={props.title ?? language.t("command.project.open")}
      class="theme-directory-picker overlay-palette"
      action={
        <button
          type="button"
          data-slot="directory-dialog-close"
          aria-label={language.t("common.close")}
          class="inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent p-0 leading-none text-icon-weak-base transition-[background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-strong-base focus-visible:bg-surface-base-hover focus-visible:text-icon-strong-base focus-visible:outline-none"
          onClick={() => dialog.close()}
        >
          <ClaxedoIconV2 name="close-small" size="small" />
        </button>
      }
    >
      <List
        search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => a.category === b.category ? 0 : a.category === "recent" ? -1 : 1}
        groupHeader={(group) => group.category === "recent" ? language.t("home.recentProjects") : language.t("command.project.open")}
        ref={(r) => (list = r)}
        onFilter={(value) => setFilter(cleanInput(value))}
        onKeyEvent={(e, item) => {
          if (e.key !== "Tab" || e.shiftKey || !item) return
          e.preventDefault()
          e.stopPropagation()
          const value = displayPath(item.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
        onSelect={(path) => path && resolve(path.absolute)}
      >
        {(item) => {
          const path = displayPath(item.absolute, filter(), home())
          return (
            <div class="w-full flex items-center justify-between rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {path === "~" ? "" : getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{path === "~" ? "~" : getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
