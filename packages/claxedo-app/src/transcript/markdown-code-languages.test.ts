/// <reference types="bun" />
import { expect, test } from "bun:test"
import { bundledLanguages } from "shiki/langs"
import { MARKDOWN_CODE_LANGUAGES } from "./markdown-code-languages"

test("the markdown code language table names exactly the languages shiki bundles", () => {
  expect([...MARKDOWN_CODE_LANGUAGES].sort()).toEqual(Object.keys(bundledLanguages).sort())
})
