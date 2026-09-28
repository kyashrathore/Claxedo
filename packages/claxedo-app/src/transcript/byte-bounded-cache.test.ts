import { expect, test } from "bun:test"
import { createByteBoundedCache } from "./byte-bounded-cache"

const sized = (limits: { entries: number; bytes: number }) =>
  createByteBoundedCache<string, string>(limits, (key, value) => key.length + value.length)

test("the oldest entry goes first once the byte budget is exceeded", () => {
  const cache = sized({ entries: 10, bytes: 10 })
  cache.set("a", "1234")
  cache.set("b", "1234")
  cache.set("c", "1234")
  expect(cache.peek("a")).toBeUndefined()
  expect(cache.peek("b")).toBe("1234")
  expect(cache.peek("c")).toBe("1234")
})

test("the oldest entry goes first once the entry count is exceeded", () => {
  const cache = sized({ entries: 2, bytes: 1_000 })
  cache.set("a", "x")
  cache.set("b", "x")
  cache.set("c", "x")
  expect(cache.peek("a")).toBeUndefined()
  expect(cache.peek("c")).toBe("x")
})

test("get makes an entry the newest and peek leaves its place", () => {
  const cache = sized({ entries: 2, bytes: 1_000 })
  cache.set("a", "x")
  cache.set("b", "x")
  cache.peek("a")
  cache.set("c", "x")
  expect(cache.peek("a")).toBeUndefined()

  cache.get("b")
  cache.set("d", "x")
  expect(cache.peek("b")).toBe("x")
  expect(cache.peek("c")).toBeUndefined()
})

test("an entry larger than the whole budget is not stored and keeps the one it would replace", () => {
  const cache = sized({ entries: 10, bytes: 5 })
  cache.set("a", "1")
  cache.set("a", "123456")
  expect(cache.peek("a")).toBe("1")
})

test("replacing a key counts only its new size", () => {
  const cache = sized({ entries: 10, bytes: 6 })
  cache.set("a", "12")
  cache.set("a", "1234")
  cache.set("b", "")
  expect(cache.peek("a")).toBe("1234")
  expect(cache.peek("b")).toBe("")
})
