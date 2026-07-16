import { createSignal } from "solid-js"
import {
  documentSelectionIsCurrent,
  runForCurrentDocumentSelection,
  type DocumentSelectionState,
} from "./document-selection"

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

export function createDocumentPickerController<Mention>(input: {
  directory: () => string
  scope: () => string
  sessionId: () => string | undefined
  draftId: () => string | undefined
  promptText: () => string
  list: (input: { directory: string }) => Promise<ComposerDocumentOption[]>
  openDocument: (input: { documentId: string; sessionId: string }) => Promise<Mention>
  mentionText: (mention: Mention) => string
  replaceText: (text: string) => void
  openPopover: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [selectionNotice, setSelectionNotice] = createSignal<string>()
  const [documents, setDocuments] = createSignal<ComposerDocumentOption[]>([])
  const [loading, setLoading] = createSignal(false)
  const [listError, setListError] = createSignal<unknown>()
  let generation = 0
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
  const current = (): DocumentSelectionState => ({
    generation,
    scope: input.scope(),
    ...(input.sessionId() ? { sessionId: input.sessionId() } : {}),
    ...(input.draftId() ? { draftId: input.draftId() } : {}),
    prompt: input.promptText(),
  })

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
      const sessionId = input.sessionId()
      if (!sessionId || sessionId === "new") {
        setSelectionNotice("Document unavailable: start the session before selecting /docs.")
        setOpen(false)
        return
      }
      const started = { ...current(), generation: ++generation, sessionId }
      setSelectionNotice(`Opening ${document.display}…`)
      void input.openDocument({ documentId: document.documentId, sessionId })
        .then((mention) => {
          if (!documentSelectionIsCurrent(started, current())) return
          input.replaceText(input.mentionText(mention))
          setSelectionNotice(undefined)
        })
        .catch((error: unknown) => {
          if (!documentSelectionIsCurrent(started, current())) return
          setSelectionNotice(`Document unavailable: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => runForCurrentDocumentSelection(started, current, () => setOpen(false)))
    },
  }
}
