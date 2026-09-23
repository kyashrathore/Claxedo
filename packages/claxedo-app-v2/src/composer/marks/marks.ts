import type { ImageMark, ImagePart } from "../model"

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

export type NumberedImageMark = {
  imageId: string
  filename: string
  index: number
  number: number
  mark: ImageMark
}

export const MARK_COLOR = "#e5484d"
export const MARK_TEXT_COLOR = "#ffffff"

export function numberImageMarks(images: readonly Pick<ImagePart, "id" | "filename" | "marks">[]) {
  const result: NumberedImageMark[] = []
  for (const image of images) {
    for (const [index, mark] of (image.marks ?? []).entries()) {
      result.push({ imageId: image.id, filename: image.filename, index, number: result.length + 1, mark })
    }
  }
  return result
}

export function firstMarkNumber(images: readonly Pick<ImagePart, "id" | "marks">[], imageId: string) {
  let next = 1
  for (const image of images) {
    if (image.id === imageId) return next
    next += image.marks?.length ?? 0
  }
  return next
}

export function markStyle(size: Size) {
  const radius = Math.max(12, Math.round(Math.max(size.width, size.height) * 0.012))
  return {
    radius,
    stroke: Math.max(2, Math.round(radius * 0.2)),
    fontSize: Math.round(radius * 1.15),
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

export function isPin(mark: ImageMark) {
  return mark.width === 0 && mark.height === 0
}

export function badgeCenter(mark: ImageMark, size: Size): Point {
  const { radius } = markStyle(size)
  return {
    x: clamp(mark.x, radius, size.width - radius),
    y: clamp(mark.y, radius, size.height - radius),
  }
}

export function markFromDrag(start: Point, end: Point, size: Size, pinBelow: number): ImageMark {
  const from = { x: clamp(start.x, 0, size.width), y: clamp(start.y, 0, size.height) }
  const to = { x: clamp(end.x, 0, size.width), y: clamp(end.y, 0, size.height) }
  if (Math.abs(to.x - from.x) < pinBelow && Math.abs(to.y - from.y) < pinBelow) {
    return { x: Math.round(from.x), y: Math.round(from.y), width: 0, height: 0, comment: "" }
  }
  const x = Math.round(Math.min(from.x, to.x))
  const y = Math.round(Math.min(from.y, to.y))
  return {
    x,
    y,
    width: Math.round(Math.max(from.x, to.x)) - x,
    height: Math.round(Math.max(from.y, to.y)) - y,
    comment: "",
  }
}
