import { createSignal } from "solid-js"
import { TASKS_BOUNDS, isTaskAttachmentMime, type TaskAttachmentDraft } from "@claxedo/tasks"
import { blobBase64, fitImage, imageTypeOf } from "@/surface"
import type { TasksKey } from "../i18n"

export type ImageRefusal = { readonly filename: string; readonly reason: "not_an_image" | "too_large" | "unreadable" }

async function readImageDraft(file: File): Promise<TaskAttachmentDraft | ImageRefusal> {
  if (!imageTypeOf(file)) return { filename: file.name, reason: "not_an_image" }
  const fitted = await fitImage(file, TASKS_BOUNDS.taskAttachmentMaxBytes)
  if (!fitted || !isTaskAttachmentMime(fitted.type)) return { filename: file.name, reason: "too_large" }
  try {
    return { filename: fitted.name, mime: fitted.type, data: await blobBase64(fitted.blob) }
  } catch (error) {
    console.warn("A task image could not be read", { name: file.name, error })
    return { filename: file.name, reason: "unreadable" }
  }
}

function isImageRefusal(value: TaskAttachmentDraft | ImageRefusal): value is ImageRefusal {
  return "reason" in value
}

const REFUSAL_KEYS: Readonly<Record<ImageRefusal["reason"], TasksKey>> = {
  not_an_image: "tasks.image.notImage",
  too_large: "tasks.image.tooLarge",
  unreadable: "tasks.image.unreadable",
}

function imageRefusalPhrase(refusal: ImageRefusal) {
  const limit = Math.round((TASKS_BOUNDS.taskAttachmentMaxBytes / 1024 / 1024) * 10) / 10
  return { key: REFUSAL_KEYS[refusal.reason], params: { name: refusal.filename, limit } }
}

export type ImageNotice = { readonly key: TasksKey; readonly params: Readonly<Record<string, string | number>> }

async function readAll(files: readonly File[], room: number) {
  const admitted: TaskAttachmentDraft[] = []
  let notice: ImageNotice | undefined
  for (const file of files.slice(0, Math.max(0, room))) {
    const read = await readImageDraft(file)
    if (isImageRefusal(read)) notice ??= imageRefusalPhrase(read)
    else admitted.push(read)
  }
  if (files.length > room) notice ??= { key: "tasks.image.limit", params: { max: TASKS_BOUNDS.taskAttachmentsMax } }
  return { admitted, notice }
}

export function createImageQueue(input: {
  readonly images: () => readonly TaskAttachmentDraft[]
  readonly setImages: (images: readonly TaskAttachmentDraft[]) => void
}) {
  const [notice, setNotice] = createSignal<ImageNotice>()
  const [reading, setReading] = createSignal(0)
  let reads: Promise<void> = Promise.resolve()
  const admit = (admitted: readonly TaskAttachmentDraft[], notice: ImageNotice | undefined) => {
    const room = Math.max(0, TASKS_BOUNDS.taskAttachmentsMax - input.images().length)
    const limit = { key: "tasks.image.limit" as const, params: { max: TASKS_BOUNDS.taskAttachmentsMax } }
    const next = admitted.length > room ? (notice ?? limit) : notice
    if (admitted.length > 0 && room > 0) input.setImages([...input.images(), ...admitted.slice(0, room)])
    setNotice(next)
  }
  const add = (files: readonly File[]) => {
    if (files.length === 0) return
    setNotice(undefined)
    setReading((count) => count + 1)
    reads = reads
      .then(async () => {
        try {
          const result = await readAll(files, TASKS_BOUNDS.taskAttachmentsMax - input.images().length)
          admit(result.admitted, result.notice)
        } finally {
          setReading((count) => count - 1)
        }
      })
      .catch((error: unknown) => console.warn("Reading a task image failed", error))
  }
  const remove = (index: number) => {
    setNotice(undefined)
    input.setImages(input.images().filter((_, position) => position !== index))
  }
  return { notice, reading, add, remove, drained: () => reads }
}
