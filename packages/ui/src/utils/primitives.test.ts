import { expect, test } from "bun:test"
import { Binary } from "./binary"
import { base64Decode, base64Encode, checksum, sampledChecksum } from "./encode"
import { getDirectory, getFilename, getFilenameTruncated } from "./path"
import { readableText } from "./text"

test("shared path helpers preserve Windows paths, empty inputs and extensions", () => {
  expect(getFilename("C:\\work\\folder\\file.ts\\")).toBe("file.ts")
  expect(getDirectory("C:\\work\\file.ts")).toBe("C:/work/")
  expect(getFilename(undefined)).toBe("")
  expect(getFilenameTruncated("/work/a-very-long-filename.ts", 12)).toBe("a-very-l….ts")
})

test("encoding preserves Unicode route keys and existing cache identities", () => {
  const value = "/workspace/日本語/🚀"
  expect(base64Decode(base64Encode(value))).toBe(value)
  expect(checksum("hello")).toBe("m3bicr")
  expect(checksum("")).toBeUndefined()
  expect(sampledChecksum("hello")).toBe(checksum("hello"))
  const large = "a".repeat(600_000)
  expect(sampledChecksum(large)).not.toBe(sampledChecksum("b" + large.slice(1)))
})

test("binary search returns the existing item or its sorted insertion point", () => {
  const rows = [{ id: "a" }, { id: "c" }, { id: "e" }]
  expect(Binary.search(rows, "c", (row) => row.id)).toEqual({ found: true, index: 1 })
  expect(Binary.search(rows, "b", (row) => row.id)).toEqual({ found: false, index: 1 })
  expect(Binary.search(rows, "z", (row) => row.id)).toEqual({ found: false, index: 3 })
  expect(Binary.search([], "a", String)).toEqual({ found: false, index: 0 })
})

test("readable text renders an object instead of the literal [object Object]", () => {
  // The branch two suppressed no-base-to-string findings used to hide:
  // a file body or an error line that reached `String()` as an object.
  expect(readableText({ error: { message: "boom" } })).toBe('{"error":{"message":"boom"}}')
  expect(readableText([1, 2])).toBe("[1,2]")
  expect(readableText(new Error("boom"))).toBe("boom")
  // A null-prototype object still serializes; only its name is unavailable.
  expect(readableText(Object.create(null))).toBe("{}")

  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(readableText(circular)).toBe("[unserializable Object]")

  const anonymous: Record<string, unknown> = Object.create(null)
  anonymous.self = anonymous
  expect(readableText(anonymous)).toBe("[unserializable value]")

  // Primitives keep their own toString, and nullish is "nothing to read".
  expect(readableText("text")).toBe("text")
  expect(readableText(7)).toBe("7")
  expect(readableText(false)).toBe("false")
  expect(readableText(9n)).toBe("9")
  expect(readableText(undefined)).toBe("")
  expect(readableText(null)).toBe("")
})
