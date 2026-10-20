import { SURFACE_FILE_EVENT_MAX_BYTES } from "@claxedo/plugin-api/surface"
import { blobBase64, fitImage, imageTypeOf, type FittedImage } from "./image-fit"
import type { JsonValue } from "./model"

export type PickedFile = { readonly name: string; readonly mimeType: string; readonly size: number; readonly dataBase64: string }

export type FileRefusal = "type" | "size" | "count"

export type RefusedFile = { readonly name: string; readonly reason: FileRefusal }

export type FilePick = { readonly files: readonly PickedFile[]; readonly refused: readonly RefusedFile[] }

export type FilePickRules = {
  readonly accept: readonly string[]
  readonly maxBytes: number
  readonly maxFiles: number
  readonly fitImages: boolean
}

export type FileReading = {
  readonly fit: (file: File, maxBytes: number) => Promise<FittedImage | undefined>
  readonly base64: (blob: Blob) => Promise<string>
}

const BROWSER_READING: FileReading = { fit: (file, maxBytes) => fitImage(file, maxBytes), base64: blobBase64 }

export function mimeTypeOf(file: { readonly name: string; readonly type: string }): string {
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return imageTypeOf(file) ?? (declared.length > 0 ? declared : "application/octet-stream")
}

export function isAccepted(accept: readonly string[], file: { readonly name: string; readonly type: string }): boolean {
  const mimeType = mimeTypeOf(file)
  const name = file.name.toLowerCase()
  return accept.some((rule) => {
    if (rule.startsWith(".")) return name.endsWith(rule)
    if (rule.endsWith("/*")) return mimeType.startsWith(rule.slice(0, -1))
    return rule === mimeType
  })
}

async function sized(file: File, rules: FilePickRules, reading: FileReading): Promise<{ blob: Blob; name: string; mimeType: string } | undefined> {
  if (file.size <= rules.maxBytes) return { blob: file, name: file.name, mimeType: mimeTypeOf(file) }
  if (!rules.fitImages || !imageTypeOf(file)) return undefined
  const fitted = await reading.fit(file, rules.maxBytes)
  return fitted ? { blob: fitted.blob, name: fitted.name, mimeType: fitted.type } : undefined
}

async function readOne(file: File, rules: FilePickRules, reading: FileReading, room: number): Promise<PickedFile | FileRefusal> {
  if (!isAccepted(rules.accept, file)) return "type"
  const fitted = await sized(file, rules, reading)
  if (!fitted || fitted.blob.size > room) return "size"
  try {
    return { name: fitted.name, mimeType: fitted.mimeType, size: fitted.blob.size, dataBase64: await reading.base64(fitted.blob) }
  } catch (error) {
    console.warn("A picked file could not be read", { name: file.name, error })
    return "type"
  }
}

export async function readPickedFiles(files: readonly File[], rules: FilePickRules, reading: FileReading = BROWSER_READING): Promise<FilePick> {
  const picked: PickedFile[] = []
  const refused: RefusedFile[] = []
  let room = SURFACE_FILE_EVENT_MAX_BYTES
  for (const file of files) {
    if (picked.length >= rules.maxFiles) {
      refused.push({ name: file.name, reason: "count" })
      continue
    }
    const read = await readOne(file, rules, reading, room)
    if (typeof read === "string") refused.push({ name: file.name, reason: read })
    else {
      picked.push(read)
      room -= read.size
    }
  }
  return { files: picked, refused }
}

export function filePickFields(pick: FilePick): Readonly<Record<string, JsonValue>> {
  return { files: pick.files.map((file) => ({ ...file })), refused: pick.refused.map((file) => ({ ...file })) }
}

export const FILE_PASTE_SCOPE = '[data-slot="surface-section"], [data-slot="surface-card"], [data-slot="surface-dialog"]'

export type PasteScope = "self" | "section" | undefined

export function pasteTarget<Target>(paste: PasteScope, picker: Target & { closest(selector: string): Target | null }): Target | undefined {
  if (paste === "self") return picker
  if (paste === "section") return picker.closest(FILE_PASTE_SCOPE) ?? picker
  return undefined
}
