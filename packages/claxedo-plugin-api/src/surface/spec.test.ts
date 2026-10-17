import { describe, expect, test } from "bun:test"
import { checkSurfaceSpec, surfaceMessageSchema, surfaceSpecMessages, SURFACE_CATALOG_ID } from "./index"

const form = {
  title: "Deploy settings",
  components: [
    { id: "root", component: "Column", children: ["name", "regions", "save"] },
    { id: "name", component: "TextField", label: "Name", value: { path: "/name" } },
    { id: "regions", component: "List", children: { componentId: "region", path: "/regions" } },
    { id: "region", component: "Text", text: { path: "label" } },
    { id: "save", component: "Button", child: "save-label", variant: "primary", action: { event: { name: "save", context: { name: { path: "/name" } } } } },
    { id: "save-label", component: "Text", text: "Save" },
  ],
  data: { name: "api", regions: [{ label: "us-east" }, { label: "eu-west" }] },
}

describe("checkSurfaceSpec", () => {
  test("accepts a complete spec", () => {
    const check = checkSurfaceSpec(form)
    expect(check.ok).toBe(true)
  })

  test("names the path of an unknown component and a wrong prop", () => {
    const check = checkSurfaceSpec({
      title: "Broken",
      components: [
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "Modal", trigger: "b", content: "c" },
      ],
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.issues.map((issue) => issue.path)).toContain("/components/1/component")
  })

  test("refuses a missing root, a dangling child, a reused id and a cycle", () => {
    const check = checkSurfaceSpec({
      title: "Graph",
      components: [
        { id: "top", component: "Card", child: "missing" },
        { id: "loop", component: "Card", child: "loop" },
        { id: "loop", component: "Text", text: "again" },
      ],
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.issues).toEqual(
      expect.arrayContaining([
        { path: "/components", message: "no component has the id root" },
        { path: "/components/0/child", message: "no component has the id missing" },
        { path: "/components/2/id", message: "the id loop is used twice" },
      ]),
    )
  })

  test("refuses a template whose component does not exist", () => {
    const check = checkSurfaceSpec({ title: "List", components: [{ id: "root", component: "List", children: { componentId: "row", path: "/rows" } }] })
    expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(["/components/0/children/componentId"])
  })

  test("refuses components outside the catalog's network and overlay rules", () => {
    for (const component of ["Image", "Video", "AudioPlayer", "Modal"]) {
      const check = checkSurfaceSpec({ title: component, components: [{ id: "root", component, url: "https://example.com/a" }] })
      expect(check.ok).toBe(false)
    }
  })
})

describe("surfaceSpecMessages", () => {
  test("turns a spec into valid A2UI v0.9 messages for one surface", () => {
    const check = checkSurfaceSpec(form)
    if (!check.ok) throw new Error("the fixture spec is valid")
    const messages = surfaceSpecMessages("call-1", check.spec)
    expect(messages.map((message) => surfaceMessageSchema.safeParse(message).success)).toEqual([true, true, true])
    expect(messages[0]).toEqual({ version: "v0.9", createSurface: { surfaceId: "call-1", catalogId: SURFACE_CATALOG_ID } })
  })

  test("leaves the data model out when the spec has none", () => {
    const check = checkSurfaceSpec({ title: "Static", components: [{ id: "root", component: "Text", text: "Hi" }] })
    if (!check.ok) throw new Error("the fixture spec is valid")
    expect(surfaceSpecMessages("call-2", check.spec)).toHaveLength(2)
  })
})

describe("surfaceMessageSchema", () => {
  test("refuses a surface created against another catalog", () => {
    const parsed = surfaceMessageSchema.safeParse({ version: "v0.9", createSurface: { surfaceId: "s", catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } })
    expect(parsed.success).toBe(false)
  })

  test("accepts a data-model delete as an update with no value", () => {
    expect(surfaceMessageSchema.safeParse({ version: "v0.9", updateDataModel: { surfaceId: "s", path: "/items/3" } }).success).toBe(true)
  })
})
