import { createEffect } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@opencode-ai/ui/toast"
import { usePaneCtx } from "@/features/session/app-ports"
import { usePrompt, type ContentPart, type ImageAttachmentPart, type ImageMark } from "@/features/session/providers/prompt"
import { useLanguage } from "@/platform/i18n/provider"
import { uuid } from "@/lib/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentMime, attachmentRefusal, type AttachmentRefusal, type AttachmentTarget } from "./files"
import { normalizePaste, pasteMode } from "./paste"

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

/**
 * The paste fields this reads. Declared structurally so the handler is not tied
 * to a DOM `ClipboardEvent` constructor, which no test environment here has.
 */
export type PromptPasteEvent = {
  clipboardData: {
    items: ArrayLike<{ kind: string; getAsFile: () => File | null }>
    getData: (format: string) => string
  } | null
  preventDefault: () => void
  stopPropagation: () => void
}

type PromptAttachmentsInput = {
  active: () => boolean
  editor: () => HTMLDivElement | undefined
  /** The composer's own element; the drop zone when the composer is not in a workbench slot. */
  root: () => HTMLElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  target: () => AttachmentTarget
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const pane = usePaneCtx()
  const language = useLanguage()

  const unreadable = (filename: string) => {
    showToast({
      title: language.t("prompt.toast.attachmentUnreadable.title"),
      description: language.t("prompt.toast.attachmentUnreadable.description", { filename }),
    })
  }

  const refuse = (refusal: AttachmentRefusal) => {
    showToast({
      title: language.t("prompt.toast.attachmentHarnessUnsupported.title", { harness: refusal.harness }),
      description: language.t("prompt.toast.attachmentHarnessUnsupported.description", {
        harness: refusal.harness,
        mime: refusal.mime,
      }),
    })
  }

  const capture = () => ({ scope: prompt.scope(), signal: prompt.signal(), target: input.target(), editor: input.editor() })
  const add = async (file: File, destination: ReturnType<typeof capture>): Promise<AttachmentRefusal | boolean> => {
    const { scope, signal, target, editor } = destination
    if (signal.aborted) return false
    const mime = await attachmentMime(file)
    const refusal = attachmentRefusal(mime, target)
    if (refusal) return refusal

    if (!editor) return false

    const url = await dataUrl(file, mime)
    if (!url || signal.aborted) return false

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      mime,
      dataUrl: url,
    }
    const cursor = prompt.cursor(scope) ?? getCursorPosition(editor)
    prompt.set([...prompt.current(scope), attachment], cursor, scope)
    return true
  }

  const addAttachment = async (file: File, destination = capture()) => {
    const result = await add(file, destination)
    if (result === true) return true
    if (destination.signal.aborted) return false
    if (result === false) unreadable(file.name)
    else refuse(result)
    return false
  }

  /**
   * Reports the first reason nothing was attached rather than one per file: a
   * multi-file drop onto a session that takes none of them would otherwise
   * stack a toast per file.
   */
  const addAttachments = async (files: File[], toast = true, destination = capture()) => {
    let found = false
    let refusal: AttachmentRefusal | undefined
    let unread: string | undefined

    for (const file of files) {
      const result = await add(file, destination)
      if (result === true) found = true
      else if (result === false) unread ??= file.name
      else refusal ??= result
    }

    if (!found && files.length > 0 && toast && !destination.signal.aborted) {
      if (refusal) refuse(refusal)
      else if (unread) unreadable(unread)
    }
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const setImageMarks = (id: string, marks: ImageMark[]) => {
    const next = prompt.current().map((part) => {
      if (part.type !== "image" || part.id !== id) return part
      if (marks.length > 0) return { ...part, marks }
      const { marks: _removed, ...rest } = part
      return rest
    })
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: PromptPasteEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return
    const destination = capture()

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files, true, destination)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file, destination)
        return
      }
    }

    if (!plainText) return

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  const handleDragOver = (event: DragEvent) => {
    if (!input.active() || input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleDragLeave = (event: DragEvent) => {
    if (!input.active() || input.isDialogActive()) return
    const zone = event.currentTarget
    const next = event.relatedTarget
    if (!(zone instanceof Node) || !(next instanceof Node) || !zone.contains(next)) {
      input.setDraggingType(null)
    }
  }

  const handleDrop = async (event: DragEvent) => {
    if (!input.active() || input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await addAttachments(Array.from(dropped))
  }

  // A drop is bound to the surface it can land on — the workbench slot, or the
  // composer's own frame outside the workbench — never to `document`: every
  // mounted composer would hear a window-wide drop and attach the file to its
  // own draft, and a hidden slot is `pointer-events: none` so it cannot be the
  // target here.
  createEffect(() => {
    const zone = pane?.element() ?? input.root()
    if (!zone) return
    makeEventListener(zone, "dragover", handleDragOver)
    makeEventListener(zone, "dragleave", handleDragLeave)
    makeEventListener(zone, "drop", handleDrop)
  })

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    setImageMarks,
    handlePaste,
  }
}
