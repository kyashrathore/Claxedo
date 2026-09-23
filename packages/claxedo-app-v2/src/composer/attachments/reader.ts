import { createEffect, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { machine } from "@/lib/machine"
import type { AttachmentEvent, AttachmentState, ImagePart, PromptPart } from "../model"
import { attachmentTransition, randomId } from "../model"
import { appError } from "../errors"
import { getCursorPosition } from "../editor/dom"
import { normalizePaste, pasteMode } from "../editor/paste"
import type { ComposerKey, ComposerStore } from "../store"
import { attachmentMime, attachmentRefusal, type AttachmentTarget } from "./files"

export type DraggingType = "files" | "mention" | null

type ReaderInput = {
  key: Accessor<ComposerKey>
  store: ComposerStore
  editor: () => HTMLElement | undefined
  zone: () => HTMLElement | undefined
  isDialogActive: () => boolean
  target: () => AttachmentTarget
  setDraggingType: (type: DraggingType) => void
  focusEditor: () => void
  addPart: (part: PromptPart) => boolean
  readClipboardImage?: () => Promise<File | null>
}

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error ?? new Error(`Could not read ${file.name}`)))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      resolve(idx === -1 ? value : `data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

export function createAttachmentReader(input: ReaderInput) {
  const read = async (file: File, id: string): Promise<AttachmentEvent> => {
    const mime = await attachmentMime(file)
    const refusal = attachmentRefusal(mime, input.target())
    if (refusal) {
      return {
        type: "failed",
        error: appError({ class: "invalid", code: "attachment.refused", message: `${refusal.harness} cannot take ${refusal.mime}` }),
      }
    }
    try {
      const url = await dataUrl(file, mime)
      const part: ImagePart = { type: "image", id, filename: file.name, mime, dataUrl: url }
      return { type: "read", part }
    } catch (cause) {
      return {
        type: "failed",
        error: appError({ class: "invalid", code: "attachment.unreadable", message: cause instanceof Error ? cause.message : String(cause) }),
      }
    }
  }

  const add = async (file: File) => {
    const key = input.key()
    const id = randomId()
    const lifecycle = machine<AttachmentState, AttachmentEvent>({ kind: "reading", id, filename: file.name }, attachmentTransition)
    input.store.setAttachment(key, lifecycle.state())
    const editor = input.editor()
    const cursor = input.store.draft(key).cursor ?? (editor ? getCursorPosition(editor) : undefined)
    lifecycle.send(await read(file, id))
    const state = lifecycle.state()
    if (state.kind === "ready") {
      input.store.removeAttachment(key, id)
      input.store.addPart(key, state.part, cursor)
      return true
    }
    input.store.setAttachment(key, state)
    return false
  }

  const addFiles = async (files: File[]) => {
    let added = false
    for (const file of files) added = (await add(file)) || added
    return added
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    if (!clipboard) return
    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboard.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length > 0) {
      await addFiles(files)
      return
    }

    const plainText = clipboard.getData("text/plain") ?? ""
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await add(file)
        return
      }
    }
    if (!plainText) return
    insertText(normalizePaste(plainText))
  }

  const insertText = (text: string) => {
    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return
      input.focusEditor()
      input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }
    if (pasteMode(text) === "manual") return put()
    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (!inserted) put()
  }

  const handleDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return
    event.preventDefault()
    if (event.dataTransfer?.types.includes("Files")) input.setDraggingType("files")
    else if (event.dataTransfer?.types.includes("text/plain")) input.setDraggingType("mention")
  }

  const handleDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    const zone = event.currentTarget
    const next = event.relatedTarget
    if (!(zone instanceof Node) || !(next instanceof Node) || !zone.contains(next)) input.setDraggingType(null)
  }

  const handleDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return
    event.preventDefault()
    input.setDraggingType(null)
    const plainText = event.dataTransfer?.getData("text/plain")
    if (plainText?.startsWith("file:")) {
      const path = plainText.slice("file:".length)
      input.focusEditor()
      input.addPart({ type: "file", path, content: `@${path}`, start: 0, end: 0 })
      return
    }
    const dropped = event.dataTransfer?.files
    if (dropped) await addFiles(Array.from(dropped))
  }

  createEffect(() => {
    const zone = input.zone()
    if (!zone) return
    makeEventListener(zone, "dragover", handleDragOver)
    makeEventListener(zone, "dragleave", handleDragLeave)
    makeEventListener(zone, "drop", (event) => void handleDrop(event))
  })

  return { add, addFiles, handlePaste }
}
