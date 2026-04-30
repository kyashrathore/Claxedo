import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import FileTree from "@/components/file-tree"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { File as StatusFile } from "@opencode-ai/sdk/v2"

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

export function WorkspaceFilesNavigator(props: {
  activePath?: string
  onFileClick: (path: string, intent: "tab" | "review") => void
}) {
  const sdk = useSDK()
  const file = useFile()
  const [changedOnly, setChangedOnly] = createSignal(false)
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [refresh, setRefresh] = createSignal(0)
  const [status] = createResource(refresh, () =>
    sdk.client.file
      .status()
      .then((res) => res.data ?? [])
      .catch(() => [] as StatusFile[]),
  )

  const changedFiles = createMemo(() => (status() ?? []).map((item) => item.path))
  const kinds = createMemo(() => buildKinds(status() ?? []))

  createEffect(() => {
    if (!file.ready()) return
    void file.tree.list("")
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = sdk.event.listen((event) => {
    if (event.details.type !== "file.watcher.updated") return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setRefresh((value) => value + 1), 250)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    stop()
  })

  const allowedList = createMemo(() => {
    const term = search().trim().toLowerCase()
    const base = changedOnly() ? changedFiles() : undefined
    if (!term) return base
    const haystack = base ?? changedFiles()
    // When searching across all files, we don't have the full list here — rely
    // on the tree's own restriction; pass undefined so it shows all and the
    // FileTree will display the full tree. Search-filter applied to changed
    // files only; full-tree search is left to the search input expanding into
    // a flat list in a future pass.
    if (!base) return undefined
    return haystack.filter((path) => path.toLowerCase().includes(term))
  })

  const emptyChanges = createMemo(
    () => changedOnly() && !status.loading && (allowedList()?.length ?? 0) === 0,
  )

  const totalChanged = createMemo(() => changedFiles().length)

  return (
    <div class="flex size-full min-h-0 flex-col">
      <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
        <Show
          when={searchOpen()}
          fallback={
            <>
              <span class="text-[11px] text-text-weak truncate">
                <Show when={changedOnly()} fallback={<>Files</>}>
                  {totalChanged()} {totalChanged() === 1 ? "change" : "changes"}
                </Show>
              </span>
              <span class="flex-1" />
              <button
                type="button"
                aria-label={changedOnly() ? "Show all files" : "Show only changed"}
                title={changedOnly() ? "Show all files" : "Show only changed"}
                onClick={() => setChangedOnly((v) => !v)}
                class="flex items-center justify-center size-6 rounded transition-colors cursor-pointer"
                classList={{
                  "text-icon-base bg-surface-base-hover": changedOnly(),
                  "text-icon-weak-base hover:text-icon-base": !changedOnly(),
                }}
              >
                <Icon name="sliders" size="small" />
              </button>
              <button
                type="button"
                aria-label="Search files"
                title="Search files"
                onClick={() => setSearchOpen(true)}
                class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer"
              >
                <Icon name="magnifying-glass" size="small" />
              </button>
            </>
          }
        >
          <Icon name="magnifying-glass" size="small" class="text-icon-weak-base shrink-0" />
          <input
            type="text"
            value={search()}
            placeholder="Filter files..."
            autofocus
            class="flex-1 min-w-0 bg-transparent text-[12px] text-text-base placeholder:text-text-weak/60 outline-none"
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("")
                setSearchOpen(false)
              }
            }}
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={() => {
              setSearch("")
              setSearchOpen(false)
            }}
            class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer"
          >
            <Icon name="close-small" size="small" />
          </button>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        {status.loading ? (
          <div class="flex h-24 items-center justify-center">
            <Spinner class="h-4 w-4 text-text-weak" />
          </div>
        ) : emptyChanges() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No changed files</div>
        ) : (
          <FileTree
            path=""
            allowed={allowedList()}
            modified={changedFiles()}
            kinds={kinds()}
            active={props.activePath}
            draggable={false}
            onFileClick={(node) => props.onFileClick(node.path, changedOnly() ? "review" : "tab")}
          />
        )}
      </div>
    </div>
  )
}
