import { createContext, useContext, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import type { CommandEntry, MentionSource } from "@/shell/types"

export type FileMatch = { readonly path: string; readonly kind: "file" | "directory" }

export type ComposerServices = {
  readonly mentions: Accessor<readonly MentionSource[]>
  readonly commands: Accessor<readonly CommandEntry[]>
  readonly searchFiles?: (placementId: PlacementId, query: string) => Promise<readonly FileMatch[]>
  readonly readClipboardImage?: () => Promise<File | null>
}

const none: ComposerServices = { mentions: () => [], commands: () => [] }

export const ComposerServicesContext = createContext<ComposerServices>()

export function useComposerServices(): ComposerServices {
  return useContext(ComposerServicesContext) ?? none
}
