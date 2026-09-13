import { describe, expect, test } from "bun:test"
import { createPopoverDismissal, portalRootUnder } from "./popover-dismissal"

type Node = { id: string; root: string; connected: boolean }

const node = (id: string, root = id): Node => ({ id, root, connected: true })
const content = node("content")
const trigger = node("trigger")
const listbox = node("listbox", "select-portal")
const option = node("option", "select-portal")
const elsewhere = node("elsewhere", "page")
const roots: Record<string, Node> = { "select-portal": node("select-portal"), page: node("page") }

function dismissal() {
  return createPopoverDismissal<Node>({
    owns: (n) => n === content || n === trigger,
    portalRoot: (n) => roots[n.root],
    contains: (layer, n) => n.root === layer.id || n === layer,
    isConnected: (layer) => layer.connected,
  })
}

describe("a popover deciding what is inside it", () => {
  test("a layer that takes focus during an interaction begun inside is adopted, and stays inside", () => {
    const d = dismissal()
    expect(d.beginInteraction(content)).toBe(true)
    expect(d.focusIn(listbox)).toBe("adopted")
    d.endInteraction()
    expect(d.inside(option)).toBe(true)
    expect(d.focusIn(option)).toBe("inside")
  })

  test("focus landing outside with no interaction begun inside is an escape", () => {
    const d = dismissal()
    expect(d.focusIn(listbox)).toBe("outside")
  })

  test("an interaction begun outside adopts nothing", () => {
    const d = dismissal()
    expect(d.beginInteraction(elsewhere)).toBe(false)
    expect(d.focusIn(listbox)).toBe("outside")
  })

  test("the interaction window closes with the event", () => {
    const d = dismissal()
    d.beginInteraction(trigger)
    d.endInteraction()
    expect(d.focusIn(listbox)).toBe("outside")
  })

  test("an adopted layer that unmounts is forgotten", () => {
    const d = dismissal()
    d.beginInteraction(content)
    d.focusIn(listbox)
    roots["select-portal"].connected = false
    expect(d.inside(option)).toBe(false)
    roots["select-portal"].connected = true
  })

  test("a page-level root is never adopted as the popover's own", () => {
    const d = createPopoverDismissal<Node>({
      owns: (n) => n === content || n === roots.page,
      portalRoot: (n) => roots[n.root],
      contains: (layer, n) => n.root === layer.id,
      isConnected: () => true,
    })
    d.beginInteraction(content)
    expect(d.focusIn(elsewhere)).toBe("outside")
  })
})

describe("the portal root under the body", () => {
  type El = { name: string; parentElement: El | null }
  const html: El = { name: "html", parentElement: null }
  const body: El = { name: "body", parentElement: html }
  const portal: El = { name: "portal", parentElement: body }
  const list: El = { name: "list", parentElement: portal }
  const item: El = { name: "item", parentElement: list }

  test("walks a portaled node up to the child of the body", () => {
    expect(portalRootUnder(body, item)).toBe(portal)
    expect(portalRootUnder(body, portal)).toBe(portal)
  })

  test("the body and the document element are not layers to adopt", () => {
    expect(portalRootUnder(body, body)).toBeUndefined()
    expect(portalRootUnder(body, html)).toBeUndefined()
  })

  test("a node outside the body's tree has no portal root", () => {
    const detached: El = { name: "detached", parentElement: { name: "other", parentElement: null } }
    expect(portalRootUnder(body, detached)).toBeUndefined()
  })
})
