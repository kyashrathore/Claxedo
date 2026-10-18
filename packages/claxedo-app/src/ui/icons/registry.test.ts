import { describe, expect, test } from "bun:test"
import { appIconNames } from "./catalog"
import { codexIconLibrary } from "./codex"
import { openCodeIconLibrary } from "./opencode"

describe("every catalog icon resolves in every library", () => {
  for (const library of [codexIconLibrary, openCodeIconLibrary]) {
    test(library.name, () => {
      for (const name of appIconNames) expect(() => library.resolve(name)).not.toThrow()
    })
  }
})
