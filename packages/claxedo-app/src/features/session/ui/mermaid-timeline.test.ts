import { afterEach, describe, expect, test } from "bun:test"
import { openMermaidViewer } from "./mermaid-viewer"

const renderedDiagram =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 120px" viewBox="0 0 120 80"><rect width="120" height="80"/><text x="10" y="20">Ready</text></svg>'

afterEach(() => {
  const close = document.querySelector<HTMLButtonElement>('[data-component="mermaid-viewer"] [data-action="close"]')
  close?.click()
  document.body.style.overflow = ""
})

describe("timeline Mermaid dialog viewer", () => {
  test("opens a fitted diagram without a header and supports zoom, drag, and focus restoration", async () => {
    const trigger = document.createElement("button")
    document.body.appendChild(trigger)
    trigger.focus()
    document.body.style.overflow = "clip"
    let renderedSource = ""
    let sanitized = false

    openMermaidViewer(
      "flowchart LR; A-->B",
      async (source) => {
        renderedSource = source
        return renderedDiagram
      },
      (svg) => {
        sanitized = true
        return svg
      },
    )
    await Promise.resolve()
    await Promise.resolve()

    const viewer = document.querySelector<HTMLElement>('[data-component="mermaid-viewer"]')
    const dialog = viewer?.querySelector<HTMLElement>('[data-slot="mermaid-viewer-dialog"]')
    const viewport = viewer?.querySelector<HTMLElement>('[data-slot="mermaid-viewer-viewport"]')
    const content = viewer?.querySelector<HTMLElement>('[data-slot="mermaid-viewer-content"]')
    const drag = viewer?.querySelector<HTMLButtonElement>('[data-action="drag"]')
    const zoomIn = viewer?.querySelector<HTMLButtonElement>('[data-action="zoom-in"]')
    const zoomValue = viewer?.querySelector<HTMLButtonElement>('[data-action="reset"]')

    expect(renderedSource).toBe("flowchart LR; A-->B")
    expect(sanitized).toBe(true)
    expect(dialog?.getAttribute("role")).toBe("dialog")
    expect(dialog?.getAttribute("aria-label")).toBe("Diagram viewer")
    expect(viewer?.querySelector('[data-slot="mermaid-viewer-header"]')).toBeNull()
    expect(content?.querySelector("svg")?.textContent).toContain("Ready")
    expect(content?.style.width).toBe("120px")
    expect(content?.style.height).toBe("80px")
    expect(content?.querySelector<SVGSVGElement>("svg")?.style.maxWidth).toBe("none")
    expect(document.body.style.overflow).toBe("hidden")
    expect(document.activeElement).toBe(viewport)

    zoomIn?.click()
    expect(zoomValue?.textContent).toBe("110%")
    expect(content?.style.transform).toContain("scale(1.1)")

    drag?.click()
    expect(drag?.getAttribute("aria-pressed")).toBe("false")
    expect(viewer?.dataset.panEnabled).toBe("false")
    drag?.click()
    expect(drag?.getAttribute("aria-pressed")).toBe("true")

    Object.assign(viewport!, {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    viewport?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 10, clientY: 20 }),
    )
    viewport?.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: 30, clientY: 35 }),
    )
    viewport?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }))
    expect(content?.style.transform).toContain("translate(20px, 15px)")

    viewer?.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }))
    expect(zoomValue?.textContent).toBe("100%")
    expect(content?.style.transform).toContain("translate(0px, 0px)")

    viewer?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(document.querySelector('[data-component="mermaid-viewer"]')).toBeNull()
    expect(document.body.style.overflow).toBe("clip")
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
