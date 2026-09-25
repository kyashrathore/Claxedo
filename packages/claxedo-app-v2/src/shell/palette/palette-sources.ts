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
import type { CommandOption } from "./registrations"

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
      return server.queryClient.fetchQuery(server.queries.files.search(placement, text)).catch(failed(placement))
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

export function createPaletteSources(input: PaletteSourcesInput) {
  const t = useTranslator(shellDictionary)
  const commands = useCommands()
  const files = useFileReads(input.placementId)
  const allowed = createMemo(() => (input.filesOnly() ? [] : paletteCommands(commands.options())))
  const toEntry = (option: CommandOption) => commandEntry(option, t("shell.palette.group.commands"), commands.keybind(option.id) || undefined)
  const toFile = (path: string) => fileEntry(path, t("shell.palette.group.files"))
  return {
    commandList: () => allowed().map(toEntry),
    commandPicks: () => commonCommands(allowed()).map(toEntry),
    recentFiles: () => input.recentFiles().slice(0, ENTRY_LIMIT).map(toFile),
    rootFiles: async () =>
      (await files.root())
        .filter((node) => node.kind === "file")
        .map((node) => node.path)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, ENTRY_LIMIT)
        .map(toFile),
    searchFiles: async (text: string) => (await files.search(text)).map(toFile),
    sessions: useSessionSource(input.placementId),
  }
}
