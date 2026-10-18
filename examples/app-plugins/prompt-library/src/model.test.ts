import { describe, expect, test } from "bun:test"
import { BUILT_IN_CATEGORIES, BUILT_IN_TEMPLATES } from "./library"
import {
  categoriesOf,
  checkDraft,
  codeSnippet,
  diffPatches,
  fillPrompt,
  labelFor,
  libraryView,
  missingText,
  missingVariables,
  placeholders,
  previewMarkdown,
  readDraft,
  readValues,
  recordUse,
  selectedView,
  templateFromDraft,
  toggleFavourite,
  valuesFor,
  type Library,
} from "./model"

const library: Library = { templates: BUILT_IN_TEMPLATES, favourites: [], usage: {} }
const refactor = BUILT_IN_TEMPLATES.find((template) => template.id === "extract-module")!

describe("the built-in library", () => {
  test("has fifteen templates across the built-in categories, each declaring exactly the variables its body uses", () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(15)
    expect(new Set(BUILT_IN_TEMPLATES.map((template) => template.id)).size).toBe(15)
    for (const template of BUILT_IN_TEMPLATES) {
      expect(BUILT_IN_CATEGORIES).toContain(template.category)
      expect(template.variables.map((variable) => variable.name)).toEqual(placeholders(template.body))
    }
  })

  test("groups cards into one tab per category with counts", () => {
    const view = libraryView(library)
    expect(view.tabs.map((tab) => tab.title)).toEqual(["Debugging (3)", "Testing (3)", "Refactoring (2)", "Review (3)", "Documentation (2)", "Planning (2)"])
    expect(view.header).toBe("15 templates · 0 favourites · 0 sent")
    expect(view.favouritesTitle).toBe("★ Favourites (0)")
  })
})

describe("filling a template", () => {
  test("fills given values and keeps blanks as placeholders", () => {
    expect(fillPrompt("Move {concept} out of {source}.", { concept: " routing ", source: "" })).toBe("Move routing out of {source}.")
    expect(missingVariables(refactor, { source: "app.ts", concept: " " })).toEqual(["concept"])
  })

  test("previews the filled prompt as a quote and names what is still missing", () => {
    expect(previewMarkdown({ ...refactor, body: "Line {source}\nLine two" }, {})).toBe("> Line {source}\n> Line two")
    expect(missingText(refactor, { source: "a.ts" })).toBe("{concept}")
    expect(missingText(refactor, {})).toBe("{source}, {concept}")
    expect(missingText(refactor, { source: "a.ts", concept: "routing" })).toBe("")
  })

  test("restores saved values for the template's variables only", () => {
    expect(valuesFor(refactor, { source: "a.ts", other: "x" })).toEqual({ source: "a.ts", concept: "" })
    expect(readValues({ source: "a.ts", bad: 3 })).toEqual({ source: "a.ts" })
    expect(readValues(["no"])).toEqual({})
  })

  test("renders a session call with every string escaped", () => {
    expect(codeSnippet({ projectId: "p1", title: "Fix", prompt: 'Say "hi"\nnow' })).toBe(
      ['const ref = await api.sessions.create({', '  projectId: "p1",', '  title: "Fix",', '  prompt: "Say \\"hi\\"\\nnow",', "})", "api.sessions.open(ref)"].join("\n"),
    )
  })
})

describe("favourites and usage", () => {
  test("a star toggles one template in and out of favourites and ignores unknown ids", () => {
    const liked = toggleFavourite(library, "flaky-test")
    expect(liked.favourites).toEqual(["flaky-test"])
    expect(libraryView(liked).favourites.map((card) => [card.favouriteLabel, card.favouriteIcon])).toEqual([["Remove from favourites", "star"]])
    expect(libraryView(liked).tabs.flatMap((tab) => tab.items).filter((card) => card.id !== "flaky-test").every((card) => card.favouriteIcon === "starOff")).toBe(true)
    expect(toggleFavourite(liked, "flaky-test").favourites).toEqual([])
    expect(toggleFavourite(liked, "missing")).toBe(liked)
  })

  test("lists favourites in their own tab and counts uses", () => {
    const used = recordUse(recordUse({ ...library, favourites: ["changelog"] }, "changelog"), "changelog")
    const view = libraryView(used)
    expect(view.favourites.map((card) => [card.id, card.usage, card.usageTone, card.favouriteLabel])).toEqual([["changelog", "Used 2×", "accent", "Remove from favourites"]])
    expect(view.tabs[0]!.items[0]!.usageTone).toBe("neutral")
    expect(view.header).toBe("15 templates · 1 favourites · 2 sent")
  })

  test("sums up the selected template's category, variables and uses in one line", () => {
    expect(selectedView(recordUse(library, refactor.id), refactor)).toEqual({
      id: "extract-module",
      name: "Extract a module",
      byline: "Refactoring · 2 variables · Used 1×",
      description: refactor.description,
    })
  })
})

describe("your own templates", () => {
  const draft = { name: "Bench a query", category: "Debugging", newCategory: "", description: "", body: "Benchmark {query_name} against {dataset} and {dataset}." }

  test("parses variables from braces and labels them", () => {
    expect(checkDraft(draft, BUILT_IN_TEMPLATES)).toEqual({ errors: [], variables: ["query_name", "dataset"] })
    expect(labelFor("query_name")).toBe("Query name")
    expect(labelFor("baseBranch")).toBe("Base branch")
  })

  test("requires a name, a category and a body, and refuses duplicates and malformed variables", () => {
    expect(checkDraft({ ...draft, name: " ", category: "", body: "" }, BUILT_IN_TEMPLATES).errors).toEqual([
      "Give the template a name.",
      "Pick a category or type a new one.",
      "Write the prompt body.",
    ])
    expect(checkDraft({ ...draft, name: "security REVIEW" }, BUILT_IN_TEMPLATES).errors).toEqual(["A template named “security REVIEW” already exists."])
    expect(checkDraft({ ...draft, body: "Use {two words} and {}" }, BUILT_IN_TEMPLATES).errors).toEqual([
      "Variable names start with a letter and use letters, digits, - or _: {two words}, {}.",
    ])
  })

  test("builds a template with a unique id, preferring a new category", () => {
    const first = templateFromDraft({ ...draft, newCategory: " Data " }, BUILT_IN_TEMPLATES)
    expect([first.id, first.category, first.description]).toEqual(["custom-bench-a-query", "Data", "_Your own template._"])
    expect(first.variables).toEqual([
      { name: "query_name", label: "Query name" },
      { name: "dataset", label: "Dataset" },
    ])
    expect(templateFromDraft(draft, [...BUILT_IN_TEMPLATES, first]).id).toBe("custom-bench-a-query-2")
    expect(categoriesOf([...BUILT_IN_TEMPLATES, first])).toEqual([...BUILT_IN_CATEGORIES, "Data"])
  })

  test("reads the draft from an action context", () => {
    expect(readDraft({ name: "N", category: ["Review"], body: "B" })).toEqual({ name: "N", category: "Review", newCategory: "", description: "", body: "B" })
  })
})

describe("minimal patches", () => {
  test("descends into same-shaped lists and records and replaces what changed shape", () => {
    expect(diffPatches("/tabs", [{ title: "A", items: [1] }], [{ title: "A", items: [2] }])).toEqual([{ path: "/tabs/0/items/0", value: 2 }])
    expect(diffPatches("/tabs", [{ items: [1] }], [{ items: [1, 2] }])).toEqual([{ path: "/tabs/0/items", value: [1, 2] }])
    expect(diffPatches("/x", { a: 1 }, { b: 1 })).toEqual([{ path: "/x", value: { b: 1 } }])
    expect(diffPatches("/x", { "a/b": 1 }, { "a/b": 2 })).toEqual([{ path: "/x/a~1b", value: 2 }])
    expect(diffPatches("/x", [1], [1])).toEqual([])
  })
})
