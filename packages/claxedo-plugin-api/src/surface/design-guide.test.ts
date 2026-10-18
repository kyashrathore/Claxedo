import { describe, expect, test } from "bun:test"
import { SURFACE_DESIGN_GUIDE, SURFACE_ROOT_ID, checkSurfaceSpec, componentReferences, type SurfaceSpec } from "./index"

const recipes: unknown[] = [...SURFACE_DESIGN_GUIDE.matchAll(/^~~~json\n([\s\S]*?)\n~~~$/gm)].map((match) => JSON.parse(match[1] ?? ""))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTemplate(value: unknown): value is { componentId: string; path: string } {
  return isRecord(value) && typeof value.componentId === "string" && typeof value.path === "string"
}

function isBinding(value: unknown): value is { path: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.path === "string"
}

function read(scope: unknown, path: string): unknown {
  return path
    .split("/")
    .filter(Boolean)
    .reduce((value, key) => (Array.isArray(value) ? value[Number(key)] : isRecord(value) ? value[key] : undefined), scope)
}

function drawnBindings(spec: SurfaceSpec) {
  const byId = new Map(spec.components.map((component) => [component.id, component]))
  const unresolved: string[] = []
  const drawn = new Set<string>()
  const resolve = (path: string, item: unknown) => (path.startsWith("/") ? read(spec.data, path) : read(item, path))
  const draw = (id: string, item: unknown) => {
    drawn.add(id)
    const component = byId.get(id)
    if (!component) return
    const templates = new Set<string>()
    const scan = (value: unknown, at: string): void => {
      if (isTemplate(value)) {
        templates.add(value.componentId)
        const items = resolve(value.path, item)
        if (!Array.isArray(items) || items.length === 0) unresolved.push(`${id}${at}: ${value.path} is not a non-empty list`)
        else for (const each of items) draw(value.componentId, each)
      } else if (isBinding(value)) {
        if (resolve(value.path, item) === undefined) unresolved.push(`${id}${at}: ${value.path}`)
      } else if (Array.isArray(value)) value.forEach((entry, index) => scan(entry, `${at}/${index}`))
      else if (isRecord(value)) for (const [key, entry] of Object.entries(value)) scan(entry, `${at}/${key}`)
    }
    scan(component, "")
    for (const reference of componentReferences(component)) if (!templates.has(reference.id)) draw(reference.id, item)
  }
  draw(SURFACE_ROOT_ID, undefined)
  return { unresolved, undrawn: spec.components.map((component) => component.id).filter((id) => !drawn.has(id)) }
}

function checkedRecipes(): SurfaceSpec[] {
  return recipes.map((recipe) => {
    const check = checkSurfaceSpec(recipe)
    if (!check.ok) throw new Error(`${isRecord(recipe) ? String(recipe.title) : "recipe"}: ${JSON.stringify(check.issues)}`)
    return check.spec
  })
}

describe("SURFACE_DESIGN_GUIDE", () => {
  test("every json block is a surface spec the check accepts", () => {
    expect(recipes.length).toBe(6)
    for (const recipe of recipes) {
      const check = checkSurfaceSpec(recipe)
      expect({ title: isRecord(recipe) ? recipe.title : undefined, issues: check.ok ? [] : check.issues }).toEqual({ title: expect.any(String), issues: [] })
    }
  })

  test("every recipe draws each of its components and every binding finds a value in its data", () => {
    for (const spec of checkedRecipes()) expect({ title: spec.title, ...drawnBindings(spec) }).toEqual({ title: spec.title, unresolved: [], undrawn: [] })
  })

  test("every recipe keeps to one primary action and at most 7 blocks under the root", () => {
    for (const spec of checkedRecipes()) {
      const primaries = spec.components.filter((component) => component.component === "Button" && component.variant === "primary").length
      const root = spec.components.find((component) => component.id === SURFACE_ROOT_ID)
      const blocks = root ? componentReferences(root).length : 0
      expect({ title: spec.title, primaries: primaries <= 1, blocks: blocks <= 7 }).toEqual({ title: spec.title, primaries: true, blocks: true })
    }
  })
})
