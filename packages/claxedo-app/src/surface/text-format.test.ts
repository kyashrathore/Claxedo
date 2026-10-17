/// <reference types="bun" />
import { expect, test } from "bun:test"
import { codeFence, webUrl } from "./text-format"
import { validationPattern } from "./validation"

test("a code block's fence is longer than any backtick run inside it", () => {
  expect(codeFence("const a = 1", "ts")).toBe("```ts\nconst a = 1\n```")
  expect(codeFence("a ```` b", undefined)).toBe("`````\na ```` b\n`````")
})

test("a link opens only an http or https address", () => {
  expect(webUrl("https://example.com/a")).toBe("https://example.com/a")
  expect(webUrl("http://example.com")).toBe("http://example.com/")
  expect(webUrl("javascript:alert(1)")).toBeUndefined()
  expect(webUrl("file:///etc/passwd")).toBeUndefined()
  expect(webUrl("not a url")).toBeUndefined()
})

test("a validation pattern matches the whole value, and a broken pattern validates nothing", () => {
  const digits = validationPattern("[0-9]+")
  expect([digits?.test("123"), digits?.test("12a")]).toEqual([true, false])
  expect(validationPattern("(")).toBeUndefined()
  expect(validationPattern(undefined)).toBeUndefined()
})
