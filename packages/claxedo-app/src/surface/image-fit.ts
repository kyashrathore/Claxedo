export const FITTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

export type FittedImageType = (typeof FITTED_IMAGE_TYPES)[number]

export type FittedImage = { readonly blob: Blob; readonly name: string; readonly type: FittedImageType }

export type ImageShrink = (file: Blob, maxBytes: number) => Promise<Blob | undefined>

export type ImageEncoding = Blob | "too_large" | undefined

const TYPE_BY_EXTENSION: Readonly<Record<string, FittedImageType>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

const EXTENSION_BY_TYPE: Readonly<Record<FittedImageType, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const LOSSY_TYPES: readonly FittedImageType[] = ["image/webp", "image/jpeg"]
const FIT_QUALITY = 0.85
const FIT_SCALE_STEP = 0.7
const FIT_ROUNDS = 6

export function isFittedImageType(value: string): value is FittedImageType {
  return FITTED_IMAGE_TYPES.some((type) => type === value)
}

function imageTypeFromName(name: string): FittedImageType | undefined {
  return name.includes(".") ? TYPE_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] : undefined
}

export function imageTypeOf(file: { readonly name: string; readonly type: string }): FittedImageType | undefined {
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (isFittedImageType(declared)) return declared
  if (declared.length > 0 && declared !== "application/octet-stream") return undefined
  return imageTypeFromName(file.name)
}

export function renamedFor(name: string, type: FittedImageType): string {
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name
  return `${stem}.${EXTENSION_BY_TYPE[type]}`
}

export async function shrinkInRounds(encodeAt: (scale: number) => Promise<ImageEncoding>): Promise<Blob | undefined> {
  let scale = 1
  for (let round = 0; round < FIT_ROUNDS; round += 1) {
    const encoded = await encodeAt(scale)
    if (encoded === undefined) return undefined
    if (encoded !== "too_large") return encoded
    scale *= FIT_SCALE_STEP
  }
  return undefined
}

async function lossyBlob(canvas: HTMLCanvasElement, maxBytes: number): Promise<ImageEncoding> {
  for (const type of LOSSY_TYPES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, FIT_QUALITY))
    if (!blob || blob.type !== type) continue
    return blob.size <= maxBytes ? blob : "too_large"
  }
  return undefined
}

export const canvasShrink: ImageShrink = async (file, maxBytes) => {
  const bitmap = await createImageBitmap(file)
  try {
    return await shrinkInRounds(async (scale) => {
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext("2d")
      if (!context) return undefined
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return lossyBlob(canvas, maxBytes)
    })
  } finally {
    bitmap.close()
  }
}

export async function fitImage(file: File, maxBytes: number, shrink: ImageShrink = canvasShrink): Promise<FittedImage | undefined> {
  const type = imageTypeOf(file)
  if (!type) return undefined
  if (file.size <= maxBytes) return { blob: file, name: file.name, type }
  const shrunk = await shrink(file, maxBytes).catch((error: unknown) => {
    console.warn("An oversized image could not be re-encoded", { name: file.name, size: file.size, error })
    return undefined
  })
  if (!shrunk || shrunk.size > maxBytes || !isFittedImageType(shrunk.type)) return undefined
  return { blob: shrunk, name: renamedFor(file.name, shrunk.type), type: shrunk.type }
}

export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error ?? new Error("the file could not be read")))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const comma = value.indexOf(",")
      if (comma === -1) reject(new Error("the file did not read as a data URL"))
      else resolve(value.slice(comma + 1))
    })
    reader.readAsDataURL(blob)
  })
}
