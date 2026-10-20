/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { fitImage, imageTypeOf, renamedFor, shrinkInRounds, type ImageEncoding } from "./image-fit"

describe("shrinkInRounds", () => {
  test("encodes at full size, then 0.7× smaller each round, for at most six rounds", async () => {
    const scales: number[] = []
    const result = await shrinkInRounds(async (scale) => {
      scales.push(Math.round(scale * 1000) / 1000)
      return "too_large"
    })
    expect(result).toBeUndefined()
    expect(scales).toEqual([1, 0.7, 0.49, 0.343, 0.24, 0.168])
  })

  test("stops at the first encoding that fits, and gives up when the encoder cannot encode", async () => {
    const fits = new Blob(["x"], { type: "image/webp" })
    const answers: ImageEncoding[] = ["too_large", "too_large", fits]
    let round = 0
    expect(await shrinkInRounds(async () => answers[round++])).toBe(fits)
    expect(round).toBe(3)
    expect(await shrinkInRounds(async () => undefined)).toBeUndefined()
  })
})

describe("fitImage", () => {
  test("keeps an image that already fits, untouched", async () => {
    const file = new File([new Uint8Array(10)], "a.png", { type: "image/png" })
    expect(await fitImage(file, 10, async () => undefined)).toEqual({ blob: file, name: "a.png", type: "image/png" })
  })

  test("renames a re-encoded image to its new type and refuses a result that is still too large or not an image", async () => {
    const file = new File([new Uint8Array(500)], "shot.png", { type: "image/png" })
    const small = new Blob([new Uint8Array(50)], { type: "image/webp" })
    expect(await fitImage(file, 100, async () => small)).toEqual({ blob: small, name: "shot.webp", type: "image/webp" })
    expect(await fitImage(file, 10, async () => small)).toBeUndefined()
    expect(await fitImage(file, 100, async () => new Blob(["x"], { type: "text/plain" }))).toBeUndefined()
  })
})

test("an image's type comes from its declared type, or from its extension when none is declared", () => {
  expect([imageTypeOf({ name: "a.JPG", type: "" }), imageTypeOf({ name: "a.bin", type: "image/gif" }), imageTypeOf({ name: "a.png", type: "image/svg+xml" })]).toEqual(["image/jpeg", "image/gif", undefined])
  expect(renamedFor("photo.final.png", "image/jpeg")).toBe("photo.final.jpg")
})
