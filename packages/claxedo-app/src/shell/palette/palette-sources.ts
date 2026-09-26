import { createMemo } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer, type FileNode, type PlacementId } from "@/server"
import { useSessionStores } from "@/session"
import { shellDictionary } from "../i18n"
import { useCommands } from "./commands"
import {
  commandEntry,
  commonCommands,
  ENTRY_LIMIT,
  fileEntry,
  paletteCommands,
  sessionEntry,
  workspaceKind,
  type PaletteEntry,
} from "./palette-entries"

export type PaletteSourcesInput = {
  readonly placementId: () => PlacementId | undefined
  readonly recentFiles: () => readonly string[]
  readonly filesOnly: () => boolean
}

function useFileReads(placementId: () => PlacementId | undefined) {
  const server = useServer()
  const failed = (placement: PlacementId) => (error: unknown) => {
    console.error("The palette could not read the workspace's files", { placement, error })
    return []
  }
  return {
    root: async (): Promise<readonly FileNode[]> => {
      const placement = placementId()
      if (!placement) return []
      return server.queryClient.fetchQuery(server.queries.files.tree(placement, "")).catch(failed(placement))
    },
    search: async (text: string): Promise<readonly string[]> => {
      const placement = placementId()
      if (!placement) return []
      return server.queryClient.fetchQuery(server.queries.files.search(placement, text, "files")).catch(failed(placement))
    },
  }
}

function useSessionSource(placementId: () => PlacementId | undefined) {
  const t = useTranslator(shellDictionary)
  const server = useServer()
  const stores = useSessionStores()
  return (): PaletteEntry[] => {
    const current = placementId()
    const project = current ? server.placements.byId(current)?.projectId : undefined
    if (!project) return []
    const list = stores.list
    return list
      .order()
      .flatMap((ref) => {
        const row = ref.projectId === project ? list.view(ref.sessionId) : undefined
        return row ? [row] : []
      })
      .map((row) => {
        const placement = server.placements.byId(row.ref.placementId)
        const description = placement ? `${t(`shell.palette.workspace.${workspaceKind(placement)}`)} : ${placement.label}` : ""
        return sessionEntry(row, { title: row.title || t("shell.palette.newSession"), description, category: t("shell.palette.group.session") })
      })
  }
}

function createFileEntries(category: () => string) {
  let shown = new Map<string, PaletteEntry>()
  return (paths: readonly string[]): PaletteEntry[] => {
    const group = category()
    const next = new Map<string, PaletteEntry>()
    for (const path of paths) {
      const known = shown.get(path)
      next.set(path, known?.category === group ? known : fileEntry(path, group))
    }
    shown = next
    return [...next.values()]
  }
}

export function createPaletteSources(input: PaletteSourcesInput) {
  const t = useTranslator(shellDictionary)
  const commands = useCommands()
  const files = useFileReads(input.placementId)
  const allowed = createMemo(() => (input.filesOnly() ? [] : paletteCommands(commands.options())))
  const commandEntries = createMemo(() =>
    allowed().map((option) => commandEntry(option, t("shell.palette.group.commands"), commands.keybind(option.id) || undefined)),
  )
  const commandPicks = createMemo(() => {
    const byId = new Map(commandEntries().map((entry) => [entry.option?.id, entry]))
    return commonCommands(allowed()).flatMap((option) => byId.get(option.id) ?? [])
  })
  const sessions = createMemo(useSessionSource(input.placementId))
  const fileEntries = createFileEntries(() => t("shell.palette.group.files"))
  return {
    commandList: commandEntries,
    commandPicks,
    sessions,
    recentAndRootFiles: async () => {
      const root = (await files.root())
        .filter((node) => node.kind === "file")
        .map((node) => node.path)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, ENTRY_LIMIT)
      return fileEntries([...new Set([...input.recentFiles().slice(0, ENTRY_LIMIT), ...root])])
    },
    recentFiles: () => fileEntries(input.recentFiles().slice(0, ENTRY_LIMIT)),
    searchFiles: async (text: string) => fileEntries(await files.search(text)),
  }
}
