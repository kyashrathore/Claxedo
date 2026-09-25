import { createEffect, createSignal, untrack } from "solid-js"
import { imageAvailability } from "./image-availability"

export type ImageFiles = { directory: string; fileUrl?: (path: string) => string | undefined }

type WaitingImage = { readonly chip: HTMLElement; readonly img: HTMLImageElement; readonly src: string }

export type ImageWaits = {
  readonly add: (image: WaitingImage) => void
  readonly commit: (root: HTMLElement) => void
}

function imageFallbackChip(img: HTMLImageElement, loading = false): HTMLElement {
  const chip = document.createElement("span")
  chip.dataset.component = "markdown-image-fallback"
  chip.dataset.state = loading ? "loading" : "error"
  if (loading) {
    chip.setAttribute("role", "img")
    chip.setAttribute("aria-busy", "true")
    chip.setAttribute("aria-label", img.getAttribute("alt") || "image")
  } else {
    chip.textContent = img.getAttribute("alt") || img.getAttribute("src") || "image"
  }
  return chip
}

function imageSource(src: string, data?: ImageFiles): string | undefined {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:") || src.startsWith("blob:")) return src
  const fileUrl = data?.fileUrl
  const directory = data?.directory
  if (!fileUrl || !directory) return undefined
  let path = src
  if (src.startsWith("file://")) {
    try {
      path = decodeURIComponent(src.slice("file://".length))
    } catch (error) {
      console.warn("A file:// image source could not be decoded", { src, error })
      return undefined
    }
  }
  if (path.startsWith("/")) {
    const prefix = directory.endsWith("/") ? directory : `${directory}/`
    if (path !== directory && !path.startsWith(prefix)) return undefined
    path = path === directory ? "" : path.slice(prefix.length)
  }
  if (!path) return undefined
  return fileUrl(path)
}

function showTile(target: Element, img: HTMLImageElement, src: string) {
  const tile = document.createElement("button")
  tile.type = "button"
  tile.dataset.component = "markdown-image-tile"
  img.removeAttribute("width")
  img.removeAttribute("height")
  if (img.getAttribute("src") !== src) img.src = src
  target.replaceWith(tile)
  tile.appendChild(img)
}

export function stabilizeImages(root: HTMLElement, waits: ImageWaits, data?: ImageFiles) {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (!(img instanceof HTMLImageElement)) continue
    const raw = img.getAttribute("src") ?? ""
    if (!raw) continue
    const src = imageSource(raw, data)
    if (!src) {
      img.replaceWith(imageFallbackChip(img))
      continue
    }
    const state = src.startsWith("data:") ? "loaded" : untrack(imageAvailability(src))
    if (state === "loaded") {
      showTile(img, img, src)
      continue
    }
    const chip = imageFallbackChip(img, state === "pending")
    img.replaceWith(chip)
    if (state === "pending") waits.add({ chip, img, src })
  }
}

function sameImages(left: readonly WaitingImage[], right: readonly WaitingImage[]) {
  return left.length === right.length && left.every((image, index) => image === right[index])
}

export function createImageWaits(): ImageWaits {
  const found = new Map<HTMLElement, WaitingImage>()
  const [waiting, setWaiting] = createSignal<readonly WaitingImage[]>([], { equals: sameImages })
  createEffect(() => {
    const settled = waiting().filter((image) => imageAvailability(image.src)() !== "pending")
    if (settled.length === 0) return
    untrack(() => {
      for (const image of settled) {
        found.delete(image.chip)
        if (!image.chip.isConnected) continue
        if (imageAvailability(image.src)() === "loaded") showTile(image.chip, image.img, image.src)
        else image.chip.replaceWith(imageFallbackChip(image.img))
      }
      setWaiting([...found.values()])
    })
  })
  return {
    add: (image) => found.set(image.chip, image),
    commit: (root) => {
      for (const chip of found.keys()) if (!root.contains(chip)) found.delete(chip)
      setWaiting([...found.values()])
    },
  }
}
