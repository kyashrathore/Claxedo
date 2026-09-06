import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import spriteMarkup from "../../../ui/src/assets/icons/codex/sprite.svg?raw"
import { iconLibraryPreference, setIconLibraryPreference, type IconLibraryPreference } from "@/ui/icons/config"
import { SEMANTIC_ICON, SemanticIcon, type SemanticIconConcept } from "@/ui/semantic-icon"

const CONCEPTS = Object.keys(SEMANTIC_ICON) as SemanticIconConcept[]
let previousPreference: IconLibraryPreference

beforeEach(() => {
  previousPreference = iconLibraryPreference()
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toMatch(/\/icons\/codex\/sprite\.svg(?:\?|$)/)
    return new Response(spriteMarkup, { headers: { "content-type": "image/svg+xml" } })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setIconLibraryPreference(previousPreference)
})

function geometry(container: HTMLElement, label: string) {
  const href = container.querySelector("use")?.getAttribute("href")
  expect(href, `${label} rendered no symbol reference`).toMatch(/^#.+/)
  const symbol = document.getElementById(href!.slice(1))
  expect(symbol, `${label} references a missing symbol`).not.toBeNull()
  expect(symbol!.querySelector("path[d],rect,circle,polygon,polyline,line,ellipse"), `${label} has no geometry`).not.toBeNull()
  return symbol!.innerHTML
}

describe.each(["codex", "opencode"] as const)("semantic icons in %s", (library) => {
  test("every concept materializes artwork from the real library", async () => {
    setIconLibraryPreference(library)
    expect(CONCEPTS.length).toBeGreaterThan(0)
    for (const concept of CONCEPTS) {
      const view = render(() => <SemanticIcon concept={concept} />)
      await waitFor(() => expect(geometry(view.container, concept).trim().length).toBeGreaterThan(0))
      view.unmount()
    }
  })

  test("the three isolation choices resolve to different geometry", async () => {
    setIconLibraryPreference(library)
    const markup: string[] = []
    for (const concept of ["isolationLocal", "isolationWorktree", "isolationCloud"] as const) {
      const view = render(() => <SemanticIcon concept={concept} />)
      await waitFor(() => expect(geometry(view.container, concept)).toBeTruthy())
      markup.push(geometry(view.container, concept))
      view.unmount()
    }
    expect(new Set(markup).size).toBe(3)
  })
})
