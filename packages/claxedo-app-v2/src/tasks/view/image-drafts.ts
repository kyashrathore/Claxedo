import { TASKS_BOUNDS, isTaskAttachmentMime, type TaskAttachmentDraft, type TaskAttachmentMime } from "@claxedo/tasks"
import type { TasksKey } from "../i18n"

export type ImageRefusal = { readonly filename: string; readonly reason: "not_an_image" | "too_large" | "unreadable" }

export type ImageShrink = (file: File, maxBytes: number) => Promise<Blob | undefined>

const MIME_BY_EXTENSION: Record<string, TaskAttachmentMime> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

const EXTENSION_BY_MIME: Record<TaskAttachmentMime, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const LOSSY: readonly TaskAttachmentMime[] = ["image/webp", "image/jpeg"]

function mimeOf(file: File): TaskAttachmentMime | undefined {
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (isTaskAttachmentMime(declared)) return declared
  if (declared.length > 0 && declared !== "application/octet-stream") return undefined
  return MIME_BY_EXTENSION[file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()]
}

function renamed(filename: string, mime: TaskAttachmentMime): string {
  const stem = filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename
  return `${stem}.${EXTENSION_BY_MIME[mime]}`
}

function base64Of(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(undefined))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const comma = value.indexOf(",")
      resolve(comma === -1 ? undefined : value.slice(comma + 1))
    })
    reader.readAsDataURL(blob)
  })
}

async function lossyBlob(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob | undefined | "too_large"> {
  for (const mime of LOSSY) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.85))
    if (!blob || blob.type !== mime) continue
    return blob.size <= maxBytes ? blob : "too_large"
  }
  return undefined
}

export const canvasShrink: ImageShrink = async (file, maxBytes) => {
  const bitmap = await createImageBitmap(file)
  try {
    let scale = 1
    for (let round = 0; round < 6; round += 1) {
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext("2d")
      if (!context) return undefined
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await lossyBlob(canvas, maxBytes)
      if (blob instanceof Blob) return blob
      scale *= 0.7
    }
    return undefined
  } finally {
    bitmap.close()
  }
}

async function shrunkOrRefused(file: File, shrink: ImageShrink): Promise<Blob | undefined> {
  const shrunk = await shrink(file, TASKS_BOUNDS.taskAttachmentMaxBytes).catch((error: unknown) => {
    console.warn("An oversized task image could not be re-encoded", error)
    return undefined
  })
  if (!shrunk || shrunk.size > TASKS_BOUNDS.taskAttachmentMaxBytes || !isTaskAttachmentMime(shrunk.type))
    return undefined
  return shrunk
}

export async function readImageDraft(
  file: File,
  shrink: ImageShrink = canvasShrink,
): Promise<TaskAttachmentDraft | ImageRefusal> {
  const mime = mimeOf(file)
  if (!mime) return { filename: file.name, reason: "not_an_image" }
  let source: Blob = file
  let stored = mime
  let filename = file.name
  if (file.size > TASKS_BOUNDS.taskAttachmentMaxBytes) {
    const shrunk = await shrunkOrRefused(file, shrink)
    if (!shrunk || !isTaskAttachmentMime(shrunk.type)) return { filename: file.name, reason: "too_large" }
    source = shrunk
    stored = shrunk.type
    filename = renamed(file.name, shrunk.type)
  }
  const data = await base64Of(source)
  if (data === undefined) return { filename: file.name, reason: "unreadable" }
  return { filename, mime: stored, data }
}

export function isImageRefusal(value: TaskAttachmentDraft | ImageRefusal): value is ImageRefusal {
  return "reason" in value
}

export function draftImageUrl(draft: TaskAttachmentDraft): string {
  return `data:${draft.mime};base64,${draft.data}`
}

const REFUSAL_KEYS: Readonly<Record<ImageRefusal["reason"], TasksKey>> = {
  not_an_image: "tasks.image.notImage",
  too_large: "tasks.image.tooLarge",
  unreadable: "tasks.image.unreadable",
}

export function imageRefusalPhrase(refusal: ImageRefusal) {
  const limit = Math.round((TASKS_BOUNDS.taskAttachmentMaxBytes / 1024 / 1024) * 10) / 10
  return { key: REFUSAL_KEYS[refusal.reason], params: { name: refusal.filename, limit } }
}
