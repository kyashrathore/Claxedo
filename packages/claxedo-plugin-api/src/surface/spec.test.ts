import { describe, expect, test } from "bun:test"
import {
  checkSurfaceSpec,
  componentReferences,
  isPluginOnlyEvent,
  surfaceComponentEvents,
  surfaceComponentSchema,
  surfaceImageUrl,
  surfaceMessageSchema,
  surfaceSpecMessages,
  SURFACE_CATALOG_ID,
  SURFACE_EVENT_FIELDS,
  SURFACE_IMAGE_MAX_DATA_URL_LENGTH,
} from "./index"

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
    for (const component of ["Video", "AudioPlayer", "Modal"]) {
      const check = checkSurfaceSpec({ title: component, components: [{ id: "root", component, url: "https://example.com/a" }] })
      expect(check.ok).toBe(false)
    }
  })
})

const overview = {
  title: "Deploy overview",
  components: [
    { id: "root", component: "Column", children: ["header", "stale", "kpis", "details", "people", "footer"] },
    { id: "footer", component: "Footer", start: ["redeploy"], end: ["live", "redeploy"] },
    { id: "stale", component: "Callout", tone: "warning", title: "Stale build", text: "Redeploy to pick up the fix.", action: "redeploy", dismissible: true },
    { id: "header", component: "Header", title: "api", subtitle: "Production", icon: "upload", badges: ["live"], actions: ["redeploy"] },
    { id: "live", component: "Badge", text: "Live", variant: "success" },
    { id: "redeploy", component: "Button", child: "redeploy-label", icon: "refresh", action: { event: { name: "redeploy" } } },
    { id: "redeploy-label", component: "Text", text: "Redeploy" },
    { id: "kpis", component: "Grid", columns: 4, gap: "small", children: ["latency"] },
    { id: "latency", component: "Stat", label: "p95", value: "182 ms", delta: "-12%", tone: "positive" },
    { id: "details", component: "Section", title: "Details", actions: ["redeploy"], child: "facts", variant: "plain" },
    { id: "facts", component: "KeyValue", items: [{ label: "Region", value: { path: "/region" } }] },
    { id: "people", component: "List", children: { componentId: "person", path: "/people" } },
    { id: "person", component: "ListItem", title: { path: "name" }, icon: { path: "icon" }, meta: ["live"], primaryAction: "redeploy-label", actions: ["redeploy"], selected: { path: "on" } },
  ],
  data: { region: "eu-west", people: [{ name: "Ana", icon: "person", on: true }] },
}

describe("the layout and display components", () => {
  test("accept a complete overview", () => {
    expect(checkSurfaceSpec(overview).ok).toBe(true)
  })

  test("accept a Button whose icon is bound, so a row toggle can show its state", () => {
    const toggle = {
      title: "Favourites",
      components: [
        { id: "root", component: "Button", child: "label", icon: { path: "/favoriteIcon" }, action: { event: { name: "toggleFavorite" } } },
        { id: "label", component: "Text", text: "Favourite" },
      ],
      data: { favoriteIcon: "star" },
    }
    expect(checkSurfaceSpec(toggle).ok).toBe(true)
  })

  test("name every child id the new containers reference", () => {
    const byId = (id: string) => surfaceComponentSchema.parse(overview.components.find((component) => component.id === id))
    expect(componentReferences(byId("header"))).toEqual([{ path: "/badges/0", id: "live" }, { path: "/actions/0", id: "redeploy" }])
    expect(componentReferences(byId("details"))).toEqual([{ path: "/child", id: "facts" }, { path: "/actions/0", id: "redeploy" }])
    expect(componentReferences(byId("person"))).toEqual([
      { path: "/meta/0", id: "live" },
      { path: "/primaryAction", id: "redeploy-label" },
      { path: "/actions/0", id: "redeploy" },
    ])
    expect(componentReferences(byId("kpis"))).toEqual([{ path: "/children/0", id: "latency" }])
    expect(componentReferences(byId("stale"))).toEqual([{ path: "/action", id: "redeploy" }])
    expect(componentReferences(surfaceComponentSchema.parse({ id: "c", component: "Callout", tone: "info", title: "T" }))).toEqual([])
    expect(componentReferences(byId("footer"))).toEqual([{ path: "/start/0", id: "redeploy" }, { path: "/end/0", id: "live" }, { path: "/end/1", id: "redeploy" }])
    expect(componentReferences(surfaceComponentSchema.parse({ id: "g", component: "Grid", children: { componentId: "cell", path: "/cells" } }))).toEqual([
      { path: "/children/componentId", id: "cell" },
    ])
  })

  test("refuse a dangling badge, action, meta, footer action, callout action and section child", () => {
    const check = checkSurfaceSpec({
      title: "Dangling",
      components: [
        { id: "root", component: "Section", child: "gone", actions: ["nope"] },
        { id: "head", component: "Header", title: "T", badges: ["missing"] },
        { id: "row", component: "ListItem", title: "R", meta: ["absent"], primaryAction: "elsewhere" },
        { id: "bar", component: "Footer", start: ["back"], end: ["next"] },
        { id: "note", component: "Callout", tone: "danger", title: "Refused", action: "retry" },
      ],
    })
    expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual([
      "/components/0/child",
      "/components/0/actions/0",
      "/components/1/badges/0",
      "/components/2/meta/0",
      "/components/2/primaryAction",
      "/components/3/start/0",
      "/components/3/end/0",
      "/components/4/action",
    ])
  })

  test("refuse a Section that contains itself", () => {
    const check = checkSurfaceSpec({ title: "Loop", components: [{ id: "root", component: "Section", child: "root" }] })
    expect(check.ok ? [] : check.issues).toContainEqual({ path: "/components/0", message: "root contains itself" })
  })

  test("refuse an unknown tone, an out-of-range column count, an unknown icon and a Footer without its end group", () => {
    const invalid = [
      { id: "root", component: "Stat", label: "L", value: "1", tone: "great" },
      { id: "root", component: "Callout", tone: "neutral", title: "T" },
      { id: "root", component: "Badge", text: "B", variant: "info" },
      { id: "root", component: "Grid", children: [], columns: 7 },
      { id: "root", component: "Grid", children: [], columns: 0 },
      { id: "root", component: "Grid", children: [], columns: 2.5 },
      { id: "root", component: "Grid", children: [], gap: "huge" },
      { id: "root", component: "Section", child: "x", variant: "raised" },
      { id: "root", component: "Header", title: "T", icon: "rocket" },
      { id: "root", component: "Header", title: "T", icon: "volumeUp" },
      { id: "root", component: "Button", child: "x", icon: "print", action: { event: { name: "p" } } },
      { id: "root", component: "KeyValue", items: [{ label: "L" }] },
      { id: "root", component: "Footer", start: ["a"] },
      { id: "root", component: "ListItem", title: "T", primaryAction: ["a"] },
      { id: "root", component: "Callout", tone: "info", title: "T", action: ["a"] },
      { id: "root", component: "Callout", tone: "info", title: "T", dismissible: "yes" },
    ]
    for (const component of invalid) expect(checkSurfaceSpec({ title: "Invalid", components: [component] }).ok).toBe(false)
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

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function image(url: unknown, extra: Record<string, unknown> = {}) {
  return { title: "Image", components: [{ id: "root", component: "Image", url, accessibility: { label: "Build badge" }, ...extra }] }
}

describe("Image", () => {
  test("accepts a base64 PNG, JPEG, GIF or WebP data: URL and a bound url", () => {
    for (const mime of ["png", "jpeg", "gif", "webp"]) expect(checkSurfaceSpec(image(PIXEL.replace("png", mime))).ok).toBe(true)
    expect(checkSurfaceSpec({ ...image({ path: "/shot" }), data: { shot: PIXEL } }).ok).toBe(true)
    expect(checkSurfaceSpec(image(PIXEL, { fit: "cover", variant: "avatar" })).ok).toBe(true)
  })

  test("refuses a literal url by scheme, SVG or malformed payload, and a blob: with no origin to compare", () => {
    const cases = ["https://example.com/a.png", "http://example.com/a.png", "file:///etc/a.png", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png,raw", "blob:https://app.example/1"]
    const issues = cases.map((url) => {
      const check = checkSurfaceSpec(image(url))
      return check.ok ? [] : check.issues.map((issue) => issue.path)
    })
    expect(issues).toEqual(cases.map(() => ["/components/0/url"]))
  })

  test("requires an accessibility label and refuses an unknown fit or variant", () => {
    const unlabelled = { title: "Image", components: [{ id: "root", component: "Image", url: PIXEL }] }
    expect(checkSurfaceSpec(unlabelled).ok).toBe(false)
    expect(checkSurfaceSpec(image(PIXEL, { accessibility: { description: "no label" } })).ok).toBe(false)
    expect(checkSurfaceSpec(image(PIXEL, { fit: "stretch" })).ok).toBe(false)
    expect(checkSurfaceSpec(image(PIXEL, { variant: "banner" })).ok).toBe(false)
  })
})

describe("surfaceImageUrl", () => {
  test("names why it refuses a url", () => {
    expect(surfaceImageUrl("https://example.com/a.png")).toEqual({ ok: false, reason: "scheme" })
    expect(surfaceImageUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toEqual({ ok: false, reason: "mime" })
    expect(surfaceImageUrl(`data:image/png;base64,${"A".repeat(SURFACE_IMAGE_MAX_DATA_URL_LENGTH)}`)).toEqual({ ok: false, reason: "size" })
    expect(surfaceImageUrl(PIXEL)).toEqual({ ok: true, url: PIXEL })
  })

  test("accepts a blob: only from the app's own non-opaque origin", () => {
    expect(surfaceImageUrl("blob:http://127.0.0.1:4000/5b1e", "http://127.0.0.1:4000")).toEqual({ ok: true, url: "blob:http://127.0.0.1:4000/5b1e" })
    expect(surfaceImageUrl("blob:null/5b1e", "http://127.0.0.1:4000")).toEqual({ ok: false, reason: "origin" })
    expect(surfaceImageUrl("blob:https://other.example/5b1e", "http://127.0.0.1:4000")).toEqual({ ok: false, reason: "origin" })
    expect(surfaceImageUrl("blob:file:///5b1e", "null")).toEqual({ ok: false, reason: "origin" })
  })
})

describe("input events", () => {
  const picker = (context: Record<string, unknown>) => ({
    title: "Region",
    components: [
      {
        id: "root",
        component: "ChoicePicker",
        options: [{ label: "EU", value: "eu" }],
        value: { path: "/region" },
        change: { event: { name: "pickRegion", context } },
      },
    ],
    data: { region: ["eu"] },
  })

  test("accept a change, submit or tab change whose context names no supplied field", () => {
    expect(checkSurfaceSpec(picker({ form: "deploy" })).ok).toBe(true)
    const spec = {
      title: "Events",
      components: [
        { id: "root", component: "Tabs", tabs: [{ title: "A", child: "name" }], selected: { path: "/tab" }, change: { event: { name: "showTab" } } },
        { id: "name", component: "TextField", label: "Name", value: { path: "/name" }, submit: { event: { name: "rename", context: { previous: "api" } } } },
      ],
      data: { tab: 0, name: "api" },
    }
    expect(checkSurfaceSpec(spec).ok).toBe(true)
  })

  test("refuse a declared context key that collides with a supplied field, at that key's pointer", () => {
    const check = checkSurfaceSpec(picker({ value: { path: "/region" } }))
    expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(["/components/0/change/event/context/value"])
    const tabs = checkSurfaceSpec({
      title: "Tabs",
      components: [
        { id: "root", component: "Tabs", tabs: [{ title: "A", child: "a" }], change: { event: { name: "showTab", context: { index: 1 } } } },
        { id: "a", component: "Text", text: "A" },
      ],
    })
    expect(tabs.ok ? [] : tabs.issues.map((issue) => issue.path)).toEqual(["/components/0/change/event/context/index"])
  })

  test("declare each component's supplied field names once", () => {
    const component = surfaceComponentSchema.parse({ id: "s", component: "Switch", label: "On", value: true, change: { event: { name: "toggle" } } })
    expect(surfaceComponentEvents(component)).toEqual([{ prop: "change", action: { event: { name: "toggle" } }, supplied: ["value"] }])
    expect(SURFACE_EVENT_FIELDS.Tabs).toEqual({ change: ["index"] })
    expect(surfaceComponentEvents(surfaceComponentSchema.parse({ id: "c", component: "CheckBox", label: "On", value: true }))).toEqual([])
  })
})

const board = {
  title: "Sprint board",
  components: [
    {
      id: "root",
      component: "Board",
      columns: [
        { key: "todo", title: "To do", items: "/todo", headerActions: ["add"], footer: "more" },
        { key: "done", title: "Done", items: "/done" },
      ],
      item: "card",
      itemKey: "id",
      movable: "movable",
      move: { event: { name: "moveCard", context: { board: "sprint" } } },
    },
    { id: "card", component: "Text", text: { path: "title" } },
    { id: "add", component: "Button", child: "add-label", icon: "add", action: { event: { name: "addCard" } } },
    { id: "add-label", component: "Text", text: "Add card" },
    { id: "more", component: "Button", child: "more-label", variant: "borderless", action: { event: { name: "loadMore" } } },
    { id: "more-label", component: "Text", text: "Load more" },
  ],
  data: { todo: [{ id: "a", title: "A", movable: true }], done: [] },
}

describe("Board", () => {
  test("accepts columns with header actions and a footer, and names every id it references", () => {
    expect(checkSurfaceSpec(board).ok).toBe(true)
    expect(componentReferences(surfaceComponentSchema.parse(board.components[0]))).toEqual([
      { path: "/item", id: "card" },
      { path: "/columns/0/headerActions/0", id: "add" },
      { path: "/columns/0/footer", id: "more" },
    ])
  })

  test("refuses a dangling item template, a reused column key and a move context naming a supplied field", () => {
    const [root, ...rest] = board.components
    const broken = {
      ...board,
      components: [
        { ...root, item: "gone", columns: [...board.components[0].columns!, { key: "todo", title: "Again", items: "/again" }], move: { event: { name: "moveCard", context: { toColumn: "x" } } } },
        ...rest,
      ],
    }
    const check = checkSurfaceSpec(broken)
    expect(check.ok ? [] : check.issues.map((issue) => issue.path)).toEqual(["/components/0/item", "/components/0/move/event/context/toColumn", "/components/0/columns/2/key"])
  })

  test("is plugin-only when it moves: an agent's spec is refused at move, and a Board without move is accepted", () => {
    const agent = checkSurfaceSpec(board, { producer: "agent" })
    expect(agent.ok ? [] : agent.issues).toEqual([{ path: "/components/0/move", message: "the Board's move event is for app plugin pages; an agent reply leaves it out" }])
    const { move: _move, ...still } = board.components[0]
    expect(checkSurfaceSpec({ ...board, components: [still, ...board.components.slice(1)] }, { producer: "agent" }).ok).toBe(true)
    expect(isPluginOnlyEvent("Board", "move")).toBe(true)
    expect(isPluginOnlyEvent("ChoicePicker", "change")).toBe(false)
  })

  test("refuses no columns, more than 12, and an unknown layout", () => {
    const root = board.components[0]
    for (const change of [{ columns: [] }, { columns: Array.from({ length: 13 }, (_, index) => ({ key: `c${index}`, title: "C", items: "/c" })) }, { layout: "grid" }]) {
      expect(checkSurfaceSpec({ ...board, components: [{ ...root, ...change }, ...board.components.slice(1)] }).ok).toBe(false)
    }
  })
})
