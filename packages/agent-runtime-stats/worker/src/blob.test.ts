import { expect, test } from "bun:test"
import { bytesFromD1 } from "./blob"

test("converts D1 BLOB result arrays back into response bytes", () => {
  expect(bytesFromD1([137, 80, 78, 71])).toEqual(new Uint8Array([137, 80, 78, 71]))
  expect(bytesFromD1(null)).toBeNull()
})
