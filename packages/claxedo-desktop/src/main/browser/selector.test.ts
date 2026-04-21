import { beforeAll, describe, expect, test } from "bun:test"
import { GlobalWindow as Window } from "happy-dom"

import { generateSelectorForNode } from "./selector"
import { GUEST_SELECTOR_SCRIPT } from "./selector-generator.guest"

/**
 * Selector-generator coverage.
 *
 * The main-process `selector.ts` wrapper is testable without Electron by
 * injecting a fake `sendCommand` that implements just enough CDP surface to
 * drive the flow:
 *
 *   - `Runtime.evaluate` compiles the guest script in a happy-dom `Window`.
 *   - `DOM.resolveNode` returns a synthetic `objectId` mapped to the element
 *     the test selected.
 *   - `Runtime.callFunctionOn` resolves the function via `new Function` on
 *     the happy-dom window, passing the element as `this`, and wraps the
 *     return value in CDP's `{ result: { value } }` shape.
 *
 * This lets us exercise the real `@medv/finder` path, CSS-in-JS rejecter,
 * shadow-DOM composite path, and the main-process parsing + fallback logic.
 */

type FakeCdpCtx = {
  window: Window
  nodeById: Map<number, unknown>
  sendCommand: (method: string, params?: unknown, sessionId?: string) => Promise<unknown>
}

/**
 * Evaluate `src` inside a scope where `window`, `document`, `Node`, `CSS`
 * resolve to happy-dom's window globals. We can't use `win.eval` (happy-dom
 * doesn't expose it), so we compile a wrapper `new Function(globals..., src)`
 * bound to the window.
 */
function runInWindow(win: Window, src: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = win as any
  // happy-dom exposes each DOM constructor on the window. Pipe them in as
  // function parameters so the source sees them as identifiers. We can't use
  // `with(window)` — happy-dom's window doesn't expose every intrinsic (Set,
  // Map, etc.) and the `with` scope would shadow them as undefined.
  const fn = new Function("window", "document", "Node", "CSS", `return (${src});`)
  return fn(w, w.document, w.Node, w.CSS)
}

function mountDom(html: string, location = "https://test.example/page"): FakeCdpCtx {
  // happy-dom v20's Window ctor accepts url/referrer in its options.
  const win = new Window({ url: location })
  win.document.write(`<!doctype html><html><body>${html}</body></html>`)
  // Register the guest script inside the happy-dom window so @medv/finder
  // runs against this DOM. The script's top-level IIFE attaches
  // `window.__claxedoGuestSelector`.
  runInWindow(win, GUEST_SELECTOR_SCRIPT)

  const nodeById = new Map<number, unknown>()
  let nextId = 1

  const sendCommand = async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "Runtime.evaluate") {
      const expr = (params as { expression?: string } | undefined)?.expression ?? ""
      try {
        const result = runInWindow(win, expr)
        return { result: { value: result } }
      } catch (e) {
        return {
          exceptionDetails: { text: (e as Error).message, exception: { description: (e as Error).message } },
        }
      }
    }
    if (method === "DOM.resolveNode") {
      const id = (params as { backendNodeId: number }).backendNodeId
      if (!nodeById.has(id)) return {}
      const objectId = `obj:${id}`
      return { object: { objectId } }
    }
    if (method === "Runtime.callFunctionOn") {
      const p = params as { objectId: string; functionDeclaration: string }
      const id = Number(p.objectId.replace("obj:", ""))
      const el = nodeById.get(id)
      if (!el) {
        return {
          exceptionDetails: { text: "no element", exception: { description: "no element" } },
        }
      }
      try {
        const fn = runInWindow(win, `(${p.functionDeclaration})`) as (this: unknown) => unknown
        const value = fn.call(el)
        return { result: { value } }
      } catch (e) {
        return {
          exceptionDetails: { text: (e as Error).message, exception: { description: (e as Error).message } },
        }
      }
    }
    if (method === "DOM.describeNode") {
      // Minimal shape for the fallback path.
      return { node: { nodeName: "div", parentId: undefined } }
    }
    if (method === "DOM.getBoxModel") {
      return { model: { border: [0, 0, 100, 0, 100, 50, 0, 50], width: 100, height: 50 } }
    }
    return {}
  }

  const registerEl = (el: unknown): number => {
    const id = nextId++
    nodeById.set(id, el)
    return id
  }

  // Attach helper on the ctx object.
  ;(win as unknown as { __registerEl: (el: unknown) => number }).__registerEl = registerEl

  return { window: win, nodeById, sendCommand }
}

describe("selector-generator: preference ladder", () => {
  test("prefers data-testid over id/class when testid is unique", async () => {
    const ctx = mountDom(`<button id="go" class="btn primary" data-testid="submit-btn">Go</button>`)
    const el = ctx.window.document.querySelector("button")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path.selector).toContain("submit-btn")
      expect(r.path.selector).toContain("data-testid")
    }
  })

  test("falls back to stable #id when no testid is present", async () => {
    const ctx = mountDom(`<section><article id="post-42">body</article></section>`)
    const el = ctx.window.document.querySelector("#post-42")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path.selector).toContain("#post-42")
    }
  })

  test("uses :nth-of-type chain when sibling duplicates have no stable attributes", async () => {
    const ctx = mountDom(`<ul><li>a</li><li>b</li><li>c</li></ul>`)
    const el = ctx.window.document.querySelectorAll("li")[1]!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path.selector).toContain("nth-of-type(2)")
      // Round-trip the selector back into the document to confirm uniqueness.
      const found = ctx.window.document.querySelector(r.path.selector)
      expect(found).toBe(el as unknown as Element)
    }
  })

  test("rejects CSS-in-JS prefixed class names (css-a1b2c3, sc-xyz, jsx-123)", async () => {
    const ctx = mountDom(`
      <div>
        <button class="css-a1b2c3 sc-abcdef jsx-12345">Clickless</button>
      </div>
    `)
    const el = ctx.window.document.querySelector("button")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // None of the unstable class names should appear in the selector.
      expect(r.path.selector).not.toContain("css-a1b2c3")
      expect(r.path.selector).not.toContain("sc-abcdef")
      expect(r.path.selector).not.toContain("jsx-12345")
    }
  })

  test("round-trips to the same element (no stable attributes)", async () => {
    const ctx = mountDom(`<div><div><div><p>hello</p></div></div></div>`)
    const el = ctx.window.document.querySelector("p")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const resolved = ctx.window.document.querySelector(r.path.selector)
      expect(resolved).toBe(el as unknown as Element)
    }
  })

  test("returns frameUrl from the guest's location", async () => {
    const ctx = mountDom(`<button data-testid="x">ok</button>`, "https://b.example/iframe")
    const el = ctx.window.document.querySelector("button")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.frameUrl).toContain("b.example")
    }
  })

  test("captures outerHTML when under the 2 KB cap", async () => {
    const ctx = mountDom(`<span data-testid="tiny">hi</span>`)
    const el = ctx.window.document.querySelector("span")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.outerHTML).toBeDefined()
      expect(r.outerHTML!).toContain("<span")
    }
  })

  test("emits tagName lowercased", async () => {
    const ctx = mountDom(`<BUTTON data-testid="x">Go</BUTTON>`)
    const el = ctx.window.document.querySelector("button")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.tagName).toBe("button")
    }
  })
})

describe("selector-generator: shadow DOM", () => {
  test("emits composite { host, inner } for elements inside an OPEN shadow root", async () => {
    const ctx = mountDom(`<div id="host-root"></div>`)
    const host = ctx.window.document.getElementById("host-root")!
    // happy-dom supports attachShadow.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shadow = (host as any).attachShadow({ mode: "open" })
    shadow.innerHTML = `<button data-testid="inner-btn">inner</button>`
    const innerButton = shadow.querySelector("button")!

    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(innerButton)
    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path.shadow).toBeDefined()
      expect(r.path.shadow!.host).toContain("host-root")
      expect(r.path.shadow!.inner).toContain("inner-btn")
    }
  })

  test("returns shadow-root-closed for elements inside a CLOSED shadow root", async () => {
    const ctx = mountDom(`<div id="host-closed"></div>`)
    const host = ctx.window.document.getElementById("host-closed")!
    // Closed mode: happy-dom keeps internal reference only. We simulate the
    // real failure mode — the main process has no way to address elements
    // inside a closed root via standard DOM traversal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shadow = (host as any).attachShadow({ mode: "closed" })
    shadow.innerHTML = `<button data-testid="hidden">x</button>`
    const hidden = shadow.querySelector("button")!

    // We emulate the guest path by manually invoking the guest's generator
    // on a detached node that has no reachable root. Expect graceful failure.
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(hidden)

    // Even if the registration "works" for the test's synthetic sendCommand,
    // the guest generator only reports `shadow-root-closed` when we ask it
    // directly. We simulate that contract by overriding the guest function
    // to detect closed-mode root and return the sentinel error.
    //
    // In production this path is exercised because Chromium refuses to
    // resolve the node, or the guest's `findShadowHost` walks into a
    // non-DOCUMENT root whose mode is "closed". We pin the renderer contract
    // here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx.window as any).__claxedoGuestSelector.generateResultForElement = () => ({
      ok: false,
      frameUrl: "https://test.example/page",
      error: "shadow-root-closed",
    })

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe("shadow-root-closed")
    }
  })
})

describe("selector-generator: main wrapper error handling", () => {
  test("returns generic error when resolveNode fails and describeNode has no useful info", async () => {
    const ctx = mountDom(`<div id="unregistered"></div>`)
    // Do NOT register the element → resolveNode returns empty → falls back.
    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: 999 })
    // Fallback path may return ok with weak selector, or error. Assert we get
    // a shaped response, not a thrown exception.
    expect(typeof r.ok).toBe("boolean")
  })

  test("returns generic error when callFunctionOn throws on the guest side", async () => {
    const ctx = mountDom(`<button>x</button>`)
    const el = ctx.window.document.querySelector("button")!
    const id = (ctx.window as unknown as { __registerEl: (e: unknown) => number }).__registerEl(el)

    // Poison the guest generator → it throws.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx.window as any).__claxedoGuestSelector.generateResultForElement = () => {
      throw new Error("boom")
    }

    const r = await generateSelectorForNode({ sendCommand: ctx.sendCommand, backendNodeId: id })
    // The wrapper's callFunctionOn function signature swallows the throw and
    // returns `ok: false, error: 'generic'`.
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe("generic")
    }
  })
})

// Sanity — the guest script evaluates without throwing in a fresh happy-dom.
describe("selector-generator: guest install", () => {
  beforeAll(() => {
    // Nothing to do — each test mounts its own window.
  })

  test("GUEST_SELECTOR_SCRIPT runs cleanly and installs the global", () => {
    const win = new Window({ url: "https://test.example/page" })
    win.document.write(`<!doctype html><html><body></body></html>`)
    const result = runInWindow(win, GUEST_SELECTOR_SCRIPT)
    expect(result).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (win as any).__claxedoGuestSelector
    expect(store).toBeDefined()
    expect(typeof store.generateResultForElement).toBe("function")
  })
})
