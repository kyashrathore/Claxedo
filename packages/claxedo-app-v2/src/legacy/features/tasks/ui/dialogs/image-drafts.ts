import { TASKS_BOUNDS, isTaskAttachmentMime, type TaskAttachmentDraft, type TaskAttachmentMime } from "@claxedo/tasks"

export type ImageRefusal = {
  filename: string
  reason: "not_an_image" | "too_large" | "unreadable"
}

/** Re-encodes an image so it decodes to at most `maxBytes`, or undefined when no encoding gets there. */
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

function mimeOf(file: File): TaskAttachmentMime | undefined {
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (isTaskAttachmentMime(declared)) return declared
  if (declared.length > 0 && declared !== "application/octet-stream") return undefined
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension]
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

/**
 * The lossy encodings a canvas offers, tried in order: WebP keeps transparency
 * and is the smaller, and a browser that cannot encode it answers `toBlob`
 * with a PNG, which the type check catches.
 */
const LOSSY: readonly TaskAttachmentMime[] = ["image/webp", "image/jpeg"]

/**
 * A retina screenshot is a multi-megabyte PNG. Re-encoded lossy at its own
 * size it usually lands under the cap; each round after that draws it at 70%
 * of the previous width, so six rounds reach 12% before giving up.
 */
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
      for (const mime of LOSSY) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.85))
        if (!blob || blob.type !== mime) continue
        if (blob.size <= maxBytes) return blob
        break
      }
      scale *= 0.7
    }
    return undefined
  } finally {
    bitmap.close()
  }
}

/**
 * The file as the create command carries it. A file over the cap is shrunk
 * rather than refused, because the cap is the store's and the person only
 * wants the agent to see the screenshot; a shrunk file is renamed for the
 * encoding it now has.
 */
export async function readImageDraft(file: File, shrink: ImageShrink = canvasShrink): Promise<TaskAttachmentDraft | ImageRefusal> {
  const mime = mimeOf(file)
  if (!mime) return { filename: file.name, reason: "not_an_image" }
  let source: Blob = file
  let stored = mime
  let filename = file.name
  if (file.size > TASKS_BOUNDS.taskAttachmentMaxBytes) {
    const shrunk = await shrink(file, TASKS_BOUNDS.taskAttachmentMaxBytes).catch(() => undefined)
    if (!shrunk || shrunk.size > TASKS_BOUNDS.taskAttachmentMaxBytes || !isTaskAttachmentMime(shrunk.type)) {
      return { filename: file.name, reason: "too_large" }
    }
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

export function imageRefusalMessage(refusal: ImageRefusal): string {
  switch (refusal.reason) {
    case "not_an_image":
      return `${refusal.filename} is not a PNG, JPEG, GIF or WebP image.`
    case "too_large":
      return `${refusal.filename} could not be brought under ${Math.round(TASKS_BOUNDS.taskAttachmentMaxBytes / 1024 / 1024 * 10) / 10} MiB.`
    case "unreadable":
      return `${refusal.filename} could not be read.`
    default: {
      const exhaustive: never = refusal.reason
      return exhaustive
    }
  }
}
