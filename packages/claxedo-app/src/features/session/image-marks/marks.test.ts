import { describe, expect, test } from "bun:test"
import type { ImageMark } from "@/features/session/providers/prompt"
import { badgeCenter, firstMarkNumber, markFromDrag, markStyle, numberImageMarks } from "./marks"

const mark = (comment: string, x = 10, y = 10): ImageMark => ({ x, y, width: 20, height: 20, comment })

describe("numberImageMarks", () => {
  test("numbers run through every image in draft order", () => {
    const images = [
      { id: "a", filename: "a.png", marks: [mark("one"), mark("two")] },
      { id: "b", filename: "b.png" },
      { id: "c", filename: "c.png", marks: [mark("three")] },
    ]
    expect(numberImageMarks(images).map((entry) => [entry.imageId, entry.index, entry.number, entry.mark.comment])).toEqual([
      ["a", 0, 1, "one"],
      ["a", 1, 2, "two"],
      ["c", 0, 3, "three"],
    ])
    expect(firstMarkNumber(images, "a")).toBe(1)
    expect(firstMarkNumber(images, "b")).toBe(3)
    expect(firstMarkNumber(images, "c")).toBe(3)
  })

  test("removing a mark renumbers every later mark, including other images", () => {
    const before = [
      { id: "a", filename: "a.png", marks: [mark("one"), mark("two")] },
      { id: "b", filename: "b.png", marks: [mark("three")] },
    ]
    const after = [{ ...before[0], marks: [mark("two")] }, before[1]]
    expect(numberImageMarks(after).map((entry) => [entry.mark.comment, entry.number])).toEqual([
      ["two", 1],
      ["three", 2],
    ])
  })
})

describe("markFromDrag", () => {
  const size = { width: 400, height: 300 }

  test("normalises a drag in any direction into a box", () => {
    expect(markFromDrag({ x: 200, y: 150 }, { x: 50.4, y: 20.6 }, size, 4)).toEqual({
      x: 50,
      y: 21,
      width: 150,
      height: 129,
      comment: "",
    })
  })

  test("a drag shorter than the threshold on both axes is a pin at the start point", () => {
    expect(markFromDrag({ x: 100, y: 80 }, { x: 102, y: 83 }, size, 4)).toEqual({
      x: 100,
      y: 80,
      width: 0,
      height: 0,
      comment: "",
    })
  })

  test("a drag past the image edge is clamped to the image", () => {
    expect(markFromDrag({ x: 350, y: 250 }, { x: 900, y: -40 }, size, 4)).toEqual({
      x: 350,
      y: 0,
      width: 50,
      height: 250,
      comment: "",
    })
  })
})

describe("badge geometry", () => {
  test("badges scale with the image and never drop below a legible size", () => {
    expect(markStyle({ width: 200, height: 100 }).radius).toBe(12)
    expect(markStyle({ width: 3000, height: 2000 }).radius).toBe(36)
  })

  test("a badge on the image edge is pulled inside so it is not cropped", () => {
    const size = { width: 400, height: 300 }
    expect(badgeCenter({ x: 0, y: 299, width: 0, height: 0, comment: "" }, size)).toEqual({ x: 12, y: 288 })
    expect(badgeCenter({ x: 100, y: 50, width: 40, height: 40, comment: "" }, size)).toEqual({ x: 100, y: 50 })
  })
})
