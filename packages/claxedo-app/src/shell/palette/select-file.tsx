import { createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import type { PlacementId } from "@/server"
import { useDialog, ClaxedoIcon as Icon, Dialog, FileIcon, Keybind, List, DialogBody } from "@/ui"
import { getDirectory, getFilename } from "@/ui/utils"
import { shellDictionary } from "../i18n"
import { useShellRoute } from "../router"
import { sessionPath } from "../routes"
import { relativeAge, type PaletteEntry } from "./palette-entries"
import { createPaletteSources } from "./palette-sources"

export type DialogSelectFileProps = {
  readonly mode?: "all" | "files"
  readonly placementId: PlacementId | undefined
  readonly recentFiles?: () => readonly string[]
  readonly onOpenFile: (path: string) => void
}

function FileRow(props: { readonly path: string }): JSX.Element {
  return (
    <div class="w-full flex items-center justify-between rounded-md pl-1">
      <div class="flex items-center gap-x-3 grow min-w-0">
        <FileIcon node={{ path: props.path, type: "file" }} class="shrink-0 size-4" />
        <div class="flex items-center text-14-regular">
          <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">{getDirectory(props.path)}</span>
          <span class="text-text-strong whitespace-nowrap">{getFilename(props.path)}</span>
        </div>
      </div>
    </div>
  )
}

function SessionRow(props: { readonly item: PaletteEntry }): JSX.Element {
  const t = useTranslator(shellDictionary)
  const now = useAgeClock(() => props.item.updated)
  const age = () => (props.item.updated ? relativeAge(props.item.updated, now()) : undefined)
  return (
    <div class="w-full flex items-center justify-between rounded-md pl-1">
      <div class="flex items-center gap-x-3 grow min-w-0">
        <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak-base" />
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-14-regular text-text-strong truncate">{props.item.title}</span>
          <Show when={props.item.description}>
            <span class="text-14-regular text-text-weak truncate">{props.item.description}</span>
          </Show>
        </div>
      </div>
      <Show when={age()}>{(value) => <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">{t(value().key, { count: value().count })}</span>}</Show>
    </div>
  )
}

function EntryRow(props: { readonly item: PaletteEntry }): JSX.Element {
  return (
    <Switch fallback={<FileRow path={props.item.path ?? ""} />}>
      <Match when={props.item.type === "command"}>
        <div class="w-full flex items-center justify-between gap-4">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-14-regular text-text-strong whitespace-nowrap">{props.item.title}</span>
            <Show when={props.item.description}>
              <span class="text-14-regular text-text-weak truncate">{props.item.description}</span>
            </Show>
          </div>
          <Show when={props.item.keys}>
            {(keys) => <Keybind keys={keys()} />}
          </Show>
        </div>
      </Match>
      <Match when={props.item.type === "session"}>
        <SessionRow item={props.item} />
      </Match>
    </Switch>
  )
}

function createEntries(props: DialogSelectFileProps, setGrouped: (grouped: boolean) => void) {
  const filesOnly = () => props.mode === "files"
  const sources = createPaletteSources({ placementId: () => props.placementId, recentFiles: () => props.recentFiles?.() ?? [], filesOnly })
  return async (text: string): Promise<PaletteEntry[]> => {
    const query = text.trim()
    setGrouped(query.length > 0)
    if (!query && filesOnly()) return sources.recentAndRootFiles()
    if (!query) return [...sources.commandPicks(), ...sources.recentFiles()]
    if (filesOnly()) return sources.searchFiles(query)
    return [...sources.commandList(), ...sources.sessions(), ...(await sources.searchFiles(query))]
  }
}

export function DialogSelectFile(props: DialogSelectFileProps): JSX.Element {
  const t = useTranslator(shellDictionary)
  const dialog = useDialog()
  const routing = useShellRoute()
  const [grouped, setGrouped] = createSignal(false)
  const items = createEntries(props, setGrouped)
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const label = () => (props.mode === "files" ? t("shell.palette.searchFiles") : t("shell.palette.placeholder"))
  const move = (item: PaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = item?.type === "command" ? item.option?.onHighlight?.() : undefined
  }
  const select = (item: PaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()
    if (item.type === "command") return item.option?.onSelect?.("palette")
    if (item.type === "session" && item.row) return routing.navigate(sessionPath(item.row.ref))
    if (item.path) props.onOpenFile(item.path)
  }
  onCleanup(() => state.committed || state.cleanup?.())
  return (
    <Dialog size="large" class="command-palette-dialog !max-h-[480px]" aria-label={label()}>
      <DialogBody>
        <div data-testid={props.mode === "files" ? "file-palette" : "command-palette"}>
          <List
            search={{ placeholder: label(), autofocus: true, hideIcon: true }}
            emptyMessage={t("shell.palette.empty")}
            loadingMessage={t("shell.loading")}
            items={items}
            key={(item) => item.id}
            filterKeys={["title", "description", "category"]}
            groupBy={grouped() ? (item) => item.category : () => ""}
            onMove={move}
            onSelect={select}
          >
            {(item) => <EntryRow item={item} />}
          </List>
        </div>
      </DialogBody>
    </Dialog>
  )
}
