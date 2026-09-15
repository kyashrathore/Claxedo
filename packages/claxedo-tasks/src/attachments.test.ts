import { describe, expect, test } from "bun:test"
import { attachmentDataUrl, decodeAttachmentData, decodedByteLength, encodeAttachmentData } from "./attachments"

describe("attachment base64", () => {
  test("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
    const encoded = encodeAttachmentData(bytes)
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"))
    expect(decodeAttachmentData(encoded)).toEqual(bytes)
    expect(decodedByteLength(encoded)).toBe(256)
  })

  test("refuses the url-safe alphabet, unpadded input, and an empty string rather than decoding part of them", () => {
    expect(decodeAttachmentData("_w==")).toBeUndefined()
    expect(decodeAttachmentData("/w")).toBeUndefined()
    expect(decodeAttachmentData("")).toBeUndefined()
    expect(decodeAttachmentData("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined()
  })

  test("sizes a padded value from its length", () => {
    expect(decodedByteLength("/w==")).toBe(1)
    expect(decodedByteLength("//8=")).toBe(2)
    expect(decodedByteLength("////")).toBe(3)
  })

  test("renders the data URL a runtime prompt part carries", () => {
    expect(attachmentDataUrl({ mime: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) })).toBe(
      "data:image/png;base64,iVBORw==",
    )
  })
})
