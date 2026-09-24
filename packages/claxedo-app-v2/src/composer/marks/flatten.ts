import { MARK_COLOR, MARK_TEXT_COLOR } from "@/lib/image-mark-badge"
import type { ImagePart } from "../model"
import { badgeCenter, firstMarkNumber, isPin, markStyle } from "./marks"

async function loadImage(src: string) {
  const image = new Image()
  image.src = src
  await image.decode()
  return image
}

async function flattenImage(image: ImagePart, firstNumber: number): Promise<ImagePart> {
  const marks = image.marks ?? []
  const source = await loadImage(image.dataUrl)
  const size = { width: source.naturalWidth, height: source.naturalHeight }
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext("2d")
  if (!context) throw new Error(`Could not draw the marks on ${image.filename}`)

  const style = markStyle(size)
  context.drawImage(source, 0, 0)
  context.lineJoin = "round"
  for (const mark of marks) {
    if (isPin(mark)) continue
    context.strokeStyle = MARK_COLOR
    context.lineWidth = style.stroke
    context.strokeRect(mark.x, mark.y, mark.width, mark.height)
  }
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.font = `600 ${style.fontSize}px system-ui, sans-serif`
  for (const [index, mark] of marks.entries()) {
    const center = badgeCenter(mark, size)
    context.beginPath()
    context.arc(center.x, center.y, style.radius, 0, Math.PI * 2)
    context.fillStyle = MARK_COLOR
    context.fill()
    context.lineWidth = Math.max(1, style.stroke / 2)
    context.strokeStyle = MARK_TEXT_COLOR
    context.stroke()
    context.fillStyle = MARK_TEXT_COLOR
    context.fillText(String(firstNumber + index), center.x, center.y + style.fontSize * 0.05)
  }

  return { ...image, mime: "image/png", dataUrl: canvas.toDataURL("image/png") }
}

export async function flattenMarkedImages(images: ImagePart[]) {
  return Promise.all(
    images.map((image) =>
      image.marks?.length ? flattenImage(image, firstMarkNumber(images, image.id)) : Promise.resolve(image),
    ),
  )
}

export function hasImageMarks(images: readonly ImagePart[]) {
  return images.some((image) => (image.marks?.length ?? 0) > 0)
}
