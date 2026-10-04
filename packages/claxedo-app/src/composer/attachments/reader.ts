import { createEffect, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { machine } from "@/lib/machine"
import type { AttachmentEvent, AttachmentState, ImagePart } from "../model"
import { attachmentTransition, randomId } from "../model"
import { ServerError } from "@/server"
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

async function readAttachment(input: ReaderInput, file: File, id: string): Promise<AttachmentEvent> {
  const mime = await attachmentMime(file)
  const refusal = attachmentRefusal(mime, input.target())
  if (refusal) {
    return {
      type: "failed",
      error: new ServerError({ class: "invalid", code: "attachment.refused", message: `${refusal.harness} cannot take ${refusal.mime}` }),
      refusal,
    }
  }
  try {
    const url = await dataUrl(file, mime)
    const part: ImagePart = { type: "image", id, filename: file.name, mime, dataUrl: url }
    return { type: "read", part }
  } catch (cause) {
    return {
      type: "failed",
      error: new ServerError({ class: "invalid", code: "attachment.unreadable", message: cause instanceof Error ? cause.message : String(cause) }),
    }
  }
}

async function addAttachment(input: ReaderInput, file: File): Promise<boolean> {
  const key = input.key()
  const id = randomId()
  const lifecycle = machine<AttachmentState, AttachmentEvent>({ kind: "reading", id, filename: file.name }, attachmentTransition)
  input.store.setAttachment(key, lifecycle.state())
  const editor = input.editor()
  const target = input.store.draftRef(key)
  const cursor = input.store.draft(key).cursor ?? (editor ? getCursorPosition(editor) : undefined)
  lifecycle.send(await readAttachment(input, file, id))
  const state = lifecycle.state()
  if (state.kind !== "ready") {
    input.store.setAttachment(key, state)
    return false
  }
  input.store.removeAttachment(key, id)
  return input.store.addPartTo(target, state.part, cursor)
}

async function addFiles(input: ReaderInput, files: File[]): Promise<boolean> {
  let added = false
  for (const file of files) added = (await addAttachment(input, file)) || added
  return added
}

function insertText(input: ReaderInput, text: string): void {
  const put = () => {
    input.focusEditor()
    input.store.addPart(input.key(), { type: "text", content: text, start: 0, end: 0 })
  }
  if (pasteMode(text) === "manual") return put()
  const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
  if (!inserted) put()
}

async function handlePaste(input: ReaderInput, event: ClipboardEvent): Promise<void> {
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
    await addFiles(input, files)
    return
  }
  const plainText = clipboard.getData("text/plain") ?? ""
  if (plainText) insertText(input, normalizePaste(plainText))
}

function handleDragOver(input: ReaderInput, event: DragEvent): void {
  if (input.isDialogActive()) return
  event.preventDefault()
  if (event.dataTransfer?.types.includes("Files")) input.setDraggingType("files")
  else if (event.dataTransfer?.types.includes("text/plain")) input.setDraggingType("mention")
}

function handleDragLeave(input: ReaderInput, event: DragEvent): void {
  if (input.isDialogActive()) return
  const zone = event.currentTarget
  const next = event.relatedTarget
  if (!(zone instanceof Node) || !(next instanceof Node) || !zone.contains(next)) input.setDraggingType(null)
}

async function handleDrop(input: ReaderInput, event: DragEvent): Promise<void> {
  if (input.isDialogActive()) return
  event.preventDefault()
  input.setDraggingType(null)
  const plainText = event.dataTransfer?.getData("text/plain")
  if (plainText?.startsWith("file:")) {
    const path = plainText.slice("file:".length)
    input.focusEditor()
    input.store.addPart(input.key(), { type: "file", path, content: `@${path}`, start: 0, end: 0 })
    return
  }
  const dropped = event.dataTransfer?.files
  if (dropped) await addFiles(input, Array.from(dropped))
}

export function createAttachmentReader(input: ReaderInput) {
  createEffect(() => {
    const zone = input.zone()
    if (!zone) return
    makeEventListener(zone, "dragover", (event) => handleDragOver(input, event))
    makeEventListener(zone, "dragleave", (event) => handleDragLeave(input, event))
    makeEventListener(zone, "drop", (event) => void handleDrop(input, event))
  })
  return {
    add: (file: File) => addAttachment(input, file),
    addFiles: (files: File[]) => addFiles(input, files),
    handlePaste: (event: ClipboardEvent) => handlePaste(input, event),
  }
}
