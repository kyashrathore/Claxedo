import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import FileTree from "@/app/workbench/controls/file-tree"
import { useFile } from "@/app/providers/file"
import { useSDK } from "@/app/providers/sdk/sdk"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { File as StatusFile } from "@opencode-ai/sdk/v2"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"

type Kind = "add" | "del" | "mix"

function kindForStatus(status: StatusFile["status"] | string): Kind {
  if (status === "added") return "add"
  if (status === "deleted") return "del"
  return "mix"
}

function mergeKind(current: Kind | undefined, next: Kind) {
  if (!current) return next
  if (current === next) return current
  return "mix" as const
}

function getDirectory(file: string) {
  const index = file.lastIndexOf("/")
  if (index === -1) return ""
  return file.slice(0, index)
}

function getFilename(file: string) {
  const index = file.lastIndexOf("/")
  if (index === -1) return file
  return file.slice(index + 1)
}

function kindTextColor(kind: Kind) {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

function kindLabel(kind: Kind) {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

function buildKinds(files: readonly StatusFile[]) {
  const out = new Map<string, Kind>()
  for (const file of files) {
    const normalized = file.path.replaceAll("\\", "/").replace(/\/+$/, "")
    const kind = kindForStatus(file.status)
    out.set(normalized, kind)

    const parts = normalized.split("/")
    for (const [idx] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) continue
      out.set(dir, mergeKind(out.get(dir), kind))
    }
  }
  return out
}

function afterVisibleWork(callback: () => void, delay = 0) {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    timer = setTimeout(() => {
      timer = undefined
      if (cancelled) return
      callback()
    }, delay)
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer) clearTimeout(timer)
  }
}

export function WorkspaceFilesNavigator(props: {
  mode: "files" | "changes"
  active: boolean
  activePath?: string
  onFileClick: (path: string, intent: "tab" | "review") => void
}) {
  const sdk = useSDK()
  const file = useFile()
  const [search, setSearch] = createSignal("")
  const [refresh, setRefresh] = createSignal<number | undefined>()
  const [status] = createResource(refresh, () =>
    sdk.client.file
      .status()
      .then((res) => res.data ?? [])
      .catch(() => [] as StatusFile[]),
  )

  const changedFiles = createMemo(() => (status() ?? []).map((item) => item.path))
  const changedStatusByPath = createMemo(() =>
    new Map((status() ?? []).map((item) => [item.path, item.status] as const))
  )
  const kinds = createMemo(() => buildKinds(status() ?? []))
  const query = createMemo(() => search().trim())
  const [searchResults] = createResource(query, (term) => {
    if (props.mode === "changes") return Promise.resolve([] as string[])
    if (!term) return Promise.resolve([] as string[])
    return file.searchFiles(term)
  })

  createEffect(() => {
    if (props.mode === "changes") return
    if (!props.active) return
    if (!file.ready()) return
    const stop = afterVisibleWork(() => void file.tree.list(""))
    onCleanup(stop)
  })

  createEffect(() => {
    if (refresh() !== undefined) return
    if (!props.active) return
    const stop = afterVisibleWork(() => setRefresh(1), fastSessionSwitchAnyQuietDelay())
    onCleanup(stop)
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = sdk.event.listen((event) => {
    if (event.details.type !== "file.watcher.updated") return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setRefresh((value) => (value ?? 0) + 1), 250)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    stop()
  })

  const allowedList = createMemo(() => {
    const term = query().toLowerCase()
    const base = props.mode === "changes" ? changedFiles() : undefined
    if (!term) return base
    if (!base) return searchResults()
    return base.filter((path) => path.toLowerCase().includes(term))
  })

  const emptyChanges = createMemo(
    () => props.mode === "changes" && !status.loading && (allowedList()?.length ?? 0) === 0,
  )
  const emptySearch = createMemo(
    () => props.mode === "files" && !!query() && !searchResults.loading && (allowedList()?.length ?? 0) === 0,
  )
  const pendingFilesShell = createMemo(() => {
    if (props.mode !== "files") return false
    if (query()) return false
    if (!file.ready()) return true
    const root = file.tree.state("")
    return !root?.loaded && !root?.loading && file.tree.children("").length === 0
  })
  const rootRowsVisible = createMemo(() => props.mode === "files" && !query() && file.tree.children("").length > 0)
  const fileTreeShellReady = createMemo(() => {
    if (pendingFilesShell() || rootRowsVisible()) return true
    if (props.mode !== "files") return false
    if (query()) return false
    return !!file.tree.state("")?.loading
  })
  const fileTreeDataReady = createMemo(() => rootRowsVisible())

  const totalChanged = createMemo(() => changedFiles().length)

  return (
    <div
      data-testid="workspace-files-navigator"
      data-mode={props.mode}
      data-file-tree-shell-ready={fileTreeShellReady() ? "true" : undefined}
      data-file-tree-data-ready={fileTreeDataReady() ? "true" : undefined}
      class="flex size-full min-h-0 flex-col"
    >
      <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
        <Icon name="magnifying-glass" size="small" class="text-icon-weak-base shrink-0" />
        <div class="flex min-w-0 flex-1 items-center rounded-md border border-transparent bg-surface-base px-2 focus-within:border-border-strong-base focus-within:bg-background-base">
          <input
            type="text"
            value={search()}
            placeholder={props.mode === "changes" ? "Filter changes..." : "Search files..."}
            autofocus
            class="flex-1 min-w-0 bg-transparent text-[12px] text-text-base placeholder:text-text-weak/60 outline-none"
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("")
              }
            }}
          />
        </div>
        <Show when={query()}>
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearch("")
            }}
            class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer"
          >
            <Icon name="close-small" size="small" />
          </button>
        </Show>
        <Show when={props.mode === "changes"}>
          <span class="shrink-0 text-[11px] text-text-weak">
            {totalChanged()}
          </span>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        {pendingFilesShell() ? (
          <div data-component="filetree" class="flex flex-col gap-0.5 p-1">
            <div data-file-tree-loading class="flex flex-col gap-0.5" aria-label="Loading files">
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[76%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
              <div class="h-6 w-[61%] rounded-md bg-surface-base" />
              <div class="h-6 w-[54%] rounded-md bg-surface-base" />
            </div>
          </div>
        ) : (props.mode === "changes" && status.loading) || (props.mode === "files" && !!query() && searchResults.loading) ? (
          <div class="flex h-24 items-center justify-center">
            <Spinner class="h-4 w-4 text-text-weak" />
          </div>
        ) : emptyChanges() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No changed files</div>
        ) : emptySearch() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No files found</div>
        ) : props.mode === "changes" ? (
          <div data-testid="workspace-changed-file-list" class="flex flex-col gap-0.5 p-1">
            {allowedList()?.map((path) => {
              const status = changedStatusByPath().get(path) ?? "modified"
              const kind = kindForStatus(status)
              return (
                <button
                  type="button"
                  data-file-tree-path={path}
                  class="group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover active:bg-surface-base-active"
                  classList={{
                    "bg-surface-base-active": props.activePath === path,
                  }}
                  onClick={() => props.onFileClick(path, "review")}
                >
                  <FileIcon
                    node={{ path, type: "file" }}
                    class="size-4 shrink-0 filetree-icon filetree-icon--mono"
                    style={kindTextColor(kind)}
                    mono
                  />
                  <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span class="min-w-0 truncate text-text-base">{getFilename(path)}</span>
                    <Show when={getDirectory(path)}>
                      <span class="min-w-0 truncate text-11-regular text-text-weak/70">{getDirectory(path)}</span>
                    </Show>
                  </span>
                  <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(kind)}>
                    {kindLabel(kind)}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <FileTree
            path=""
            allowed={allowedList()}
            modified={changedFiles()}
            kinds={kinds()}
            active={props.activePath}
            draggable={false}
            visibleLimit={24}
            onFileClick={(node) => props.onFileClick(node.path, props.mode === "changes" ? "review" : "tab")}
          />
        )}
      </div>
    </div>
  )
}
