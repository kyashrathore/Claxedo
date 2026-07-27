import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { SEMANTIC_ICON, SemanticIcon, type SemanticIconConcept } from "@/ui/semantic-icon"

const CONCEPTS = Object.keys(SEMANTIC_ICON) as SemanticIconConcept[]

describe("SEMANTIC_ICON", () => {
  afterEach(() => cleanup())

  test("every concept resolves to a drawn symbol", () => {
    for (const concept of CONCEPTS) {
      const view = render(() => <SemanticIcon concept={concept} />)
      const href = view.container.querySelector("use")?.getAttribute("href")

      expect(href, `${concept} rendered no symbol reference`).toBeTruthy()
      cleanup()
    }
  })

  // These two are the alternative values of one field — the isolation row on
  // the session environment card renders one or the other. A shared glyph
  // there would make the row unreadable, so the collision is not allowed even
  // though glyph sharing is fine between concepts that never co-occur.
  test("keeps the two isolation alternatives visually distinct", () => {
    expect(SEMANTIC_ICON.isolationLocal).not.toBe(SEMANTIC_ICON.isolationWorktree)
    expect(SEMANTIC_ICON.isolationLocal).not.toBe(SEMANTIC_ICON.isolationCloud)
    expect(SEMANTIC_ICON.isolationWorktree).not.toBe(SEMANTIC_ICON.isolationCloud)
  })
})
