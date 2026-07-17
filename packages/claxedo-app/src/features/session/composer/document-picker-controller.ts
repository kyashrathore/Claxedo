import { createSignal } from "solid-js"

export type ComposerDocumentOption = {
  documentId: string
  displayName: string
  originKind: "managed" | "repository"
  placementKind: "local" | "hosted"
  status: string
}

type ComposerDocumentSelection = Omit<ComposerDocumentOption, "displayName"> & {
  type: "document"
  display: string
}

export function createDocumentPickerController(input: {
  directory: () => string
  list: (input: { directory: string }) => Promise<ComposerDocumentOption[]>
  mentionText: (document: ComposerDocumentSelection) => string
  replaceText: (text: string) => void
  openPopover: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [selectionNotice, setSelectionNotice] = createSignal<string>()
  const [documents, setDocuments] = createSignal<ComposerDocumentOption[]>([])
  const [loading, setLoading] = createSignal(false)
  const [listError, setListError] = createSignal<unknown>()
  let listGeneration = 0
  const notice = () => {
    const selected = selectionNotice()
    if (selected) return selected
    if (!open()) return
    if (loading()) return "Loading documents…"
    const error = listError()
    if (error) {
      return `Documents unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    open,
    documents,
    notice,
    show() {
      setSelectionNotice(undefined)
      setOpen(true)
      input.openPopover()
      const request = ++listGeneration
      setLoading(true)
      setListError(undefined)
      void input.list({ directory: input.directory() }).then(
        (next) => {
          if (request !== listGeneration) return
          setDocuments(next)
          setLoading(false)
        },
        (error) => {
          if (request !== listGeneration) return
          setListError(error)
          setLoading(false)
        },
      )
    },
    close() {
      setOpen(false)
    },
    select(document: ComposerDocumentSelection) {
      input.replaceText(input.mentionText(document))
      setSelectionNotice(undefined)
      setOpen(false)
    },
  }
}
