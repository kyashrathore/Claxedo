import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { createSignal, Suspense } from "solid-js"
import { afterEach, expect, test, vi } from "vitest"
import userEvent from "@testing-library/user-event"

afterEach(cleanup)

async function mount(text: string) {
  const view = render(() => (
    <Suspense fallback={null}>
      <MarkedProvider nativeParser={async (source: string) => source}>
        <Markdown text={text} />
      </MarkedProvider>
    </Suspense>
  ))
  await vi.waitFor(() => {
    if (!view.container.querySelector('[data-component="markdown"]')) throw new Error("Markdown root never mounted")
  })
  return view
}

test("a data-URL image renders inside its tile, not dropped by the reparent", async () => {
  const { container } = await mount("![chip](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=)")

  await vi.waitFor(() => {
    const tile = container.querySelector('[data-component="markdown-image-tile"]')
    expect(tile).toBeTruthy()
    const img = tile?.querySelector("img")
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=")
  })
})

test("an image the probe already cleared renders inside its tile on re-render", async () => {
  const text = "![again](data:image/webp;base64,UklGRg==)"
  const { container } = await mount(text)
  await vi.waitFor(() => expect(container.querySelector('[data-component="markdown-image-tile"] img')).toBeTruthy())

  // A second stabilize pass over the same source takes the cached-ok branch —
  // the one that used to detach the img before replacing it.
  const view = render(() => (
    <Suspense fallback={null}>
      <MarkedProvider nativeParser={async (source: string) => source}>
        <Markdown text={text} />
      </MarkedProvider>
    </Suspense>
  ))
  await vi.waitFor(() =>
    expect(view.container.querySelector('[data-component="markdown-image-tile"] img')).toBeTruthy(),
  )
})

test("HTTP images reserve a loading slot, then render and reuse a successful probe", async () => {
  const probes: HTMLImageElement[] = []
  vi.stubGlobal("Image", function () {
    const img = document.createElement("img")
    probes.push(img)
    return img
  })
  try {
    const text = "![remote image](https://example.com/loading-test.png)"
    const view = await mount(text)
    await vi.waitFor(() => expect(probes).toHaveLength(1))
    const slot = view.container.querySelector('[data-state="loading"]')
    expect(slot?.textContent).toBe("")
    expect(slot?.getAttribute("aria-label")).toBe("remote image")
    expect(slot?.getAttribute("aria-busy")).toBe("true")
    probes[0].dispatchEvent(new Event("load"))
    await vi.waitFor(() => expect(view.container.querySelector('[data-component="markdown-image-tile"] img')).toBeTruthy())
    expect(view.container.querySelector('[data-state="loading"]')).toBeNull()
    const second = await mount(text)
    await vi.waitFor(() => expect(second.container.querySelector('[data-component="markdown-image-tile"] img')).toBeTruthy())
    expect(probes).toHaveLength(1)
  } finally {
    vi.unstubAllGlobals()
  }
})

test("a failed HTTP image shows its description only after loading fails", async () => {
  const probes: HTMLImageElement[] = []
  vi.stubGlobal("Image", function () {
    const img = document.createElement("img")
    probes.push(img)
    return img
  })
  try {
    const view = await mount("![unavailable image](https://example.com/failure-test.png)")
    await vi.waitFor(() => expect(probes).toHaveLength(1))
    expect(view.container.querySelector('[data-state="loading"]')?.textContent).toBe("")
    probes[0].dispatchEvent(new Event("error"))
    await vi.waitFor(() => expect(view.container.querySelector('[data-state="error"]')?.textContent).toBe("unavailable image"))
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})


test("streamed image updates preview the currently displayed source", async () => {
  const first = "data:image/png;base64,Zmlyc3Q="
  const second = "data:image/png;base64,c2Vjb25k"
  const [text, setText] = createSignal(`![first image](${first})`)
  const view = render(() => (
    <DialogProvider>
      <Suspense fallback={null}>
        <MarkedProvider nativeParser={async (source: string) => source}>
          <Markdown text={text()} streaming />
        </MarkedProvider>
      </Suspense>
    </DialogProvider>
  ))
  await vi.waitFor(() => expect(view.container.querySelector('[data-component="markdown-image-tile"] img')).toHaveAttribute("src", first))
  setText(`![second image](${second})`)
  await vi.waitFor(() => expect(view.container.querySelector('[data-component="markdown-image-tile"] img')).toHaveAttribute("src", second))
  fireEvent.click(view.container.querySelector('[data-component="markdown-image-tile"]')!)
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("src", second))
  expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("alt", "second image")
  await userEvent.setup().keyboard("{Escape}")
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull())
})


test("a linked assistant image opens full view by keyboard without navigating its link", async () => {
  const source = "data:image/png;base64,a2V5Ym9hcmQ="
  const openedLink = vi.fn()
  const view = render(() => (
    <DialogProvider>
      <Suspense fallback={null}>
        <MarkedProvider>
          <Markdown text={`[![assistant result](${source})](https://example.com/original)`} />
        </MarkedProvider>
      </Suspense>
    </DialogProvider>
  ))
  view.container.addEventListener("claxedo:open-link", openedLink)
  await vi.waitFor(() => expect(view.container.querySelector('[data-component="markdown-image-tile"]')).toBeTruthy())
  const tile = view.container.querySelector<HTMLButtonElement>('[data-component="markdown-image-tile"]')!
  tile.focus()
  expect(document.activeElement).toBe(tile)
  await userEvent.setup().keyboard("{Enter}")
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toHaveAttribute("src", source))
  expect(openedLink).not.toHaveBeenCalled()
  await userEvent.setup().keyboard("{Escape}")
  await vi.waitFor(() => expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull())
})
