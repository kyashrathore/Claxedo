import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { List } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@/lib/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { formatKeybind, useCommand, type CommandOption } from "@/features/session/app-ports"
import { useGlobalSDK } from "@/features/session/app-ports"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useLayout } from "@/features/session/app-ports"
import { useFile } from "@/features/session/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import { getRelativeTime } from "@/lib/time"
import { useClaxedoState } from "@/features/session/app-ports"
import { sessionRoute } from "@/platform/identity/route"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { centralTransportForServer, isLocalPersonalScope } from "@/platform/runtime/transport"

type EntryType = "command" | "file" | "session"

type Entry = {
  id: string
  type: EntryType
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  archived?: number
  updated?: number
}

type DialogSelectFileMode = "all" | "files"

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.new",
  "review.toggle",
] as const

const uniqueEntries = (items: Entry[]) => {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

const createCommandEntry = (option: CommandOption, category: string): Entry => ({
  id: "command:" + option.id,
  type: "command",
  title: option.title,
  description: option.description,
  keybind: option.keybind,
  category,
  option,
})

const createFileEntry = (path: string, category: string): Entry => ({
  id: "file:" + path,
  type: "file",
  title: path,
  category,
  path,
})

const createSessionEntry = (
  input: {
    directory: string
    id: string
    title: string
    description: string
    archived?: number
    updated?: number
  },
  category: string,
): Entry => ({
  id: `session:${input.directory}:${input.id}`,
  type: "session",
  title: input.title,
  description: input.description,
  category,
  directory: input.directory,
  sessionID: input.id,
  archived: input.archived,
  updated: input.updated,
})

function createCommandEntries(props: {
  filesOnly: () => boolean
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
}) {
  const allowed = createMemo(() => {
    if (props.filesOnly()) return []
    return props.command.options.filter(
      (option) => !option.disabled && !option.id.startsWith("suggested.") && option.id !== "file.open",
    )
  })

  const list = createMemo(() => {
    const category = props.language.t("palette.group.commands")
    return allowed().map((option) => createCommandEntry(option, category))
  })

  const picks = createMemo(() => {
    const all = allowed()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = props.language.t("palette.group.commands")
    return sorted.map((option) => createCommandEntry(option, category))
  })

  return { allowed, list, picks }
}

function createFileEntries(props: {
  file: ReturnType<typeof useFile>
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  language: ReturnType<typeof useLanguage>
}) {
  const recent = createMemo(() => {
    const all = props.tabs().all()
    const active = props.tabs().active()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = props.language.t("palette.group.files")
    const items: Entry[] = []

    for (const item of order) {
      const path = props.file.pathFromTab(item)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      items.push(createFileEntry(path, category))
    }

    return items.slice(0, ENTRY_LIMIT)
  })

  const root = createMemo(() => {
    const category = props.language.t("palette.group.files")
    const nodes = props.file.tree.children("")
    const paths = nodes
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
    return paths.slice(0, ENTRY_LIMIT).map((path) => createFileEntry(path, category))
  })

  return { recent, root }
}

function createSessionEntries(props: {
  workspaces: () => string[]
  label: (directory: string) => string
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
}) {
  const [revision, setRevision] = createSignal(0)
  const state: {
    inflight: Promise<Entry[]> | undefined
    cached: Entry[] | undefined
  } = {
    inflight: undefined,
    cached: undefined,
  }

  const sessions = (text: string) => {
    revision()
    const query = text.trim()
    if (!query) return [] as Entry[]

    if (state.cached) return state.cached
    if (state.inflight) return [] as Entry[]

    const dirs = props.workspaces()
    if (dirs.length === 0) return [] as Entry[]

    state.inflight = Promise.all(
      dirs.map((directory) => {
        const description = props.label(directory)
        if (centralTransportForServer(props.globalSDK.url) === "loopback" && !isLocalPersonalScope({
          serverUrl: props.globalSDK.url,
          directory,
        })) {
          return Promise.resolve([])
        }
        return props.globalSDK.client.session
          .list({ directory, roots: true })
          .then((x) =>
            (x.data ?? [])
              .filter((s) => !!s?.id)
              .map((s) => ({
                id: s.id,
                title: s.title ?? props.language.t("command.session.new"),
                description,
                directory,
                archived: s.time?.archived,
                updated: s.time?.updated,
              })),
          )
          .catch(
            () =>
              [] as {
                id: string
                title: string
                description: string
                directory: string
                archived?: number
                updated?: number
              }[],
          )
      }),
    )
      .then((results) => {
        const seen = new Set<string>()
        const category = props.language.t("command.category.session")
        const next = results
          .flat()
          .filter((item) => {
            const key = `${item.directory}:${item.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((item) => createSessionEntry(item, category))
        state.cached = next
        setRevision((value) => value + 1)
        return next
      })
      .catch(() => {
        state.cached = []
        setRevision((value) => value + 1)
        return [] as Entry[]
      })
      .finally(() => {
        state.inflight = undefined
      })

    return [] as Entry[]
  }

  return { sessions }
}

export function DialogSelectFile(props: {
  mode?: DialogSelectFileMode
  directory: string
  sessionId?: string
  fileApi?: ReturnType<typeof useFile>
  onOpenFile?: (path: string) => void
}) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const contextFile = useFile()
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const queryOptions = useQueryOptions()
  const pathQuery = useQuery(() => queryOptions.path(null))
  let claxedoState: ReturnType<typeof useClaxedoState> | undefined
  try {
    claxedoState = useClaxedoState()
  } catch {
    /* not in claxedo mode */
  }
  const filesOnly = () => props.mode === "files"
  const file = () => props.fileApi ?? contextFile
  const sessionKey = createMemo(() =>
    sessionViewKey({
      directory: props.directory,
      sessionId: props.sessionId,
    })
  )
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const [grouped, setGrouped] = createSignal(false)
  const commandEntries = createCommandEntries({ filesOnly, command, language })
  const fileEntries = createFileEntries({ file: file(), tabs, language })

  const projectDirectory = createMemo(() => props.directory)
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const workspaces = createMemo(() => {
    const directory = projectDirectory()
    const current = project()
    if (!current) return directory ? [directory] : []

    const dirs = [current.worktree, ...(current.sandboxes ?? [])]
    if (directory && !dirs.includes(directory)) return [...dirs, directory]
    return dirs
  })
  const homedir = createMemo(() => pathQuery.data?.home)
  const label = (directory: string) => {
    const current = project()
    const kind =
      current && directory === current.worktree
        ? language.t("workspace.type.local")
        : language.t("workspace.type.sandbox")
    const home = homedir()
    const path = home ? directory.replace(home, "~") : directory
    const name = getFilename(directory)
    return `${kind} : ${name || path}`
  }

  const { sessions } = createSessionEntries({ workspaces, label, globalSDK, language })

  const items = async (text: string) => {
    const query = text.trim()
    setGrouped(query.length > 0)

    if (!query && filesOnly()) {
      const loaded = file().tree.state("")?.loaded
      const pending = loaded ? Promise.resolve() : file().tree.list("")
      const next = uniqueEntries([...fileEntries.recent(), ...fileEntries.root()])

      if (loaded || next.length > 0) {
        void pending
        return next
      }

      await pending
      return uniqueEntries([...fileEntries.recent(), ...fileEntries.root()])
    }

    if (!query) return [...commandEntries.picks(), ...fileEntries.recent()]

    if (filesOnly()) {
      const files = await file().searchFiles(query)
      const category = language.t("palette.group.files")
      return files.map((path) => createFileEntry(path, category))
    }

    const nextSessions = sessions(query)
    const files = await file().searchFiles(query)
    const category = language.t("palette.group.files")
    const entries = files.map((path) => createFileEntry(path, category))
    return [...commandEntries.list(), ...nextSessions, ...entries]
  }

  const handleMove = (item: Entry | undefined) => {
    state.cleanup?.()
    if (!item) return
    if (item.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const open = (path: string) => {
    if (claxedoState) {
      const paneId = claxedoState.wb.state.focusedPaneId
      if (paneId) {
        const activeContentId = claxedoState.wb.selectors.focusedContent()
        const active = activeContentId ? claxedoState.meta.get(activeContentId) : undefined
        const paneWorktree = claxedoState.workspace.paneWorktree(paneId)
        const dir = active?.directory ?? paneWorktree.default ?? projectDirectory()
        if (dir) {
          claxedoState.workspacePanel.open({
            workspaceDir: dir,
            targetPaneId: paneId,
            navigator: "files",
            focus: { kind: "file", path, intent: "tab" },
          })
          props.onOpenFile?.(path)
          return
        }
      }
    }

    const value = file().tab(path)
    tabs().open(value)
    file().load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(value)
  }

  const handleSelect = (item: Entry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()

    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }

    if (item.type === "session") {
      if (!item.directory || !item.sessionID) return
      navigate(sessionRoute(item.sessionID))
      return
    }

    if (!item.path) return
    open(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <Dialog
      flush
      class="claxedo-command-palette !max-h-[480px]"
      transition
      aria-label={filesOnly() ? language.t("session.header.searchFiles") : language.t("palette.search.placeholder")}
    >
      <div data-testid={filesOnly() ? "file-palette" : "command-palette"}>
        <List
          search={{
            placeholder: filesOnly()
              ? language.t("session.header.searchFiles")
              : language.t("palette.search.placeholder"),
            autofocus: true,
            hideIcon: true,
          }}
          emptyMessage={language.t("palette.empty")}
          loadingMessage={language.t("common.loading")}
          items={items}
          key={(item) => item.id}
          filterKeys={["title", "description", "category"]}
          groupBy={grouped() ? (item) => item.category : () => ""}
          onMove={handleMove}
          onSelect={handleSelect}
        >
          {(item) => (
            <Switch
              fallback={
                <div class="w-full flex items-center justify-between rounded-md pl-1">
                  <div class="flex items-center gap-x-3 grow min-w-0">
                    <FileIcon node={{ path: item.path ?? "", type: "file" }} class="shrink-0 size-4" />
                    <div class="flex items-center text-14-regular">
                      <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                        {getDirectory(item.path ?? "")}
                      </span>
                      <span class="text-text-strong whitespace-nowrap">{getFilename(item.path ?? "")}</span>
                    </div>
                  </div>
                </div>
              }
            >
              <Match when={item.type === "command"}>
                <div class="w-full flex items-center justify-between gap-4">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-14-regular text-text-strong whitespace-nowrap">{item.title}</span>
                    <Show when={item.description}>
                      <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                    </Show>
                  </div>
                  <Show when={item.keybind}>
                    <Keybind class="rounded-[4px]">{formatKeybind(item.keybind ?? "")}</Keybind>
                  </Show>
                </div>
              </Match>
              <Match when={item.type === "session"}>
                <div class="w-full flex items-center justify-between rounded-md pl-1">
                  <div class="flex items-center gap-x-3 grow min-w-0">
                    <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak-base" />
                    <div class="flex items-center gap-2 min-w-0">
                      <span
                        class="text-14-regular text-text-strong truncate"
                        classList={{ "opacity-70": !!item.archived }}
                      >
                        {item.title}
                      </span>
                      <Show when={item.description}>
                        <span
                          class="text-14-regular text-text-weak truncate"
                          classList={{ "opacity-70": !!item.archived }}
                        >
                          {item.description}
                        </span>
                      </Show>
                    </div>
                  </div>
                  <Show when={item.updated}>
                    <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                      {getRelativeTime(new Date(item.updated!).toISOString(), language.t)}
                    </span>
                  </Show>
                </div>
              </Match>
            </Switch>
          )}
        </List>
      </div>
    </Dialog>
  )
}
